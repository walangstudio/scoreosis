-- One ranked run on the client: steps the game's ranked module on wall-clock
-- ticks, uploads inputs once per second, and handles pause, resume and finish.
-- Any server refusal turns the run "local": play continues, nothing is ranked.
--
-- status: "starting" | "ranked" | "pausing" | "paused" | "resuming" |
--         "finishing" | "verified" | "local"
local codec = require "scoreosis.codec"

local M = {}
M.__index = M

local TICK_RATE = 60
local CHUNK_TICKS = 60
local MAX_CHUNK_TICKS = 120
local MAX_TICKS_PER_FRAME = 8
local RETRIES = 3

-- client: scoreosis.client; game: ranked module; now(): wall-clock seconds.
function M.new(client, game, now)
	return setmetatable({
		client = client,
		game = game,
		now = now,
		status = "starting",
		tick = 0,
		sent_tick = 0,
		seq = 0,
		pending = {},
		checksums = {},
		in_flight = false,
	}, M)
end

local function go_local(self, reason)
	if self.status == "verified" then return end
	self.status = "local"
	self.reason = reason
	local waiter = self.drained
	self.drained = nil
	if waiter then waiter(false) end
	if self.on_change then self.on_change(self) end
end

-- Starts a ranked run; callback(ok) fires once the simulation exists.
function M:start(callback)
	self.client:ensure_guest(function(ok, err)
		if not ok then
			go_local(self, err and err.code or "network")
			callback(false)
			return
		end
		self.client:call("POST", self.client:game_path("/runs"), { build_id = self.client.build_id }, function(started, run)
			if not started then
				go_local(self, run.code)
				callback(false)
				return
			end
			self.run = run
			self.sim = self.game.new(run.seed)
			self.status = "ranked"
			self.base_time, self.base_tick = self.now(), 0
			callback(true)
		end, true)
	end)
end

-- Ticks owed to real time this frame. Zero while waiting on pause or resume.
function M:due()
	if self.status ~= "ranked" and self.status ~= "local" then return 0 end
	if self.game.finished(self.sim) then return 0 end
	-- The epsilon keeps float drift in frame times from landing a hair short of a tick.
	local target = self.base_tick + math.floor((self.now() - self.base_time) * TICK_RATE + 1e-6)
	local owed = target - self.tick
	if owed > MAX_TICKS_PER_FRAME then
		-- Too far behind to catch up; drop the time. A ranked run this late is lost anyway.
		self.base_time = self.now() - (self.tick + MAX_TICKS_PER_FRAME - self.base_tick) / TICK_RATE
		owed = MAX_TICKS_PER_FRAME
	end
	return math.max(0, owed)
end

-- Advances one tick with the button bitmask.
function M:step(bits)
	self.game.step(self.sim, bits)
	self.tick = self.tick + 1
	if self.status == "local" then return end
	self.pending[#self.pending + 1] = bits
	if self.tick % CHUNK_TICKS == 0 or self.game.finished(self.sim) then
		self.checksums[self.tick] = codec.checksum(codec.encode(self.game.save(self.sim)))
	end
	self:flush()
	if self.game.finished(self.sim) then self:finish() end
end

-- Sends buffered ticks up to the latest checksummed boundary, or all of them
-- while a drain is waiting. One request in flight at a time.
function M:flush()
	if self.in_flight or self.status == "local" then return end
	local draining = self.drained ~= nil
	local last
	for i = math.min(#self.pending, MAX_CHUNK_TICKS), 1, -1 do
		if self.checksums[self.sent_tick + i] or (draining and i == #self.pending) then
			last = i
			break
		end
	end
	if not last then
		if draining and #self.pending == 0 then
			local waiter = self.drained
			self.drained = nil
			waiter(true)
		end
		return
	end
	local end_tick = self.sent_tick + last
	local checksum = self.checksums[end_tick] or codec.checksum(codec.encode(self.game.save(self.sim)))
	local ticks = {}
	for i = 1, last do ticks[i] = self.pending[i] end
	local body = {
		seq = self.seq,
		from_tick = self.sent_tick,
		inputs = codec.encode_inputs(ticks),
		checksum = checksum,
	}
	self.in_flight = true
	self:send(body, RETRIES, function(ok, ack)
		self.in_flight = false
		if not ok then
			go_local(self, ack.details and ack.details.reason or ack.code)
			return
		end
		if ack.status == "rejected" or ack.status == "expired" then
			go_local(self, ack.reason or ack.status)
			return
		end
		self.seq = self.seq + 1
		self.sent_tick = end_tick
		local rest = {}
		for i = last + 1, #self.pending do rest[#rest + 1] = self.pending[i] end
		self.pending = rest
		self.checksums[end_tick] = nil
		self:flush()
	end)
end

-- after(ok) once every buffered tick is acknowledged, or false if the run went local.
function M:drain(after)
	self.drained = after
	self:flush()
end

function M:send(body, retries, callback)
	self.client:call("POST", self.client:game_path("/runs/" .. self.run.run_id .. "/inputs"), body, function(ok, res)
		if not ok and retries > 0 and (res.status == 0 or res.status >= 500) then
			self:send(body, retries - 1, callback)
		else
			callback(ok, res)
		end
	end, true)
end

local function run_path(self, action)
	return self.client:game_path("/runs/" .. self.run.run_id .. "/" .. action)
end

-- Freeze the game first, then call this. callback(ok) when the server approved.
function M:pause(callback)
	if self.status ~= "ranked" then
		callback(self.status == "local")
		return
	end
	self.status = "pausing"
	self:drain(function(drained)
		if not drained then
			callback(false)
			return
		end
		self.client:call("POST", run_path(self, "pause"), { tick = self.tick }, function(ok, res)
			if ok then
				self.status = "paused"
			else
				go_local(self, res.details and res.details.reason or res.code)
			end
			callback(ok)
		end, true)
	end)
end

-- callback(ok) when ticking may continue. A failed resume continues locally.
function M:resume(callback)
	if self.status == "local" then
		self.base_time, self.base_tick = self.now(), self.tick
		callback(false)
		return
	end
	self.status = "resuming"
	self.client:call("POST", run_path(self, "resume"), {}, function(ok, res)
		-- The server's expected tick includes time lost to the pause round trips;
		-- due() catches up to it a few ticks per frame.
		self.base_time = self.now()
		self.base_tick = ok and res.expected_tick or self.tick
		if ok then
			self.status = "ranked"
		else
			go_local(self, res.details and res.details.reason or res.code)
		end
		callback(ok)
	end, true)
end

-- Called automatically at the terminal tick. on_result(session) fires when settled.
function M:finish()
	if self.status ~= "ranked" then
		if self.on_result then self.on_result(self) end
		return
	end
	self.status = "finishing"
	self:drain(function(drained)
		if drained then
			self:poll_finish()
		elseif self.on_result then
			self.on_result(self)
		end
	end)
end

function M:poll_finish()
	self.client:call("POST", run_path(self, "finish"), { tick = self.tick }, function(ok, res)
		if ok and res.status == "verifying" then
			self.retry_at = self.now() + (res.retry_after_ms or 1000) / 1000
			return
		end
		if ok and res.status == "finished" then
			self.status = "verified"
			self.result = res
		else
			go_local(self, ok and res.reason or res.code)
		end
		if self.on_result then self.on_result(self) end
	end, true)
end

-- Call every frame; drives finish polling.
function M:update()
	if self.status == "finishing" and self.retry_at and self.now() >= self.retry_at then
		self.retry_at = nil
		self:poll_finish()
	end
end

-- Gives up the ranked run (menu exit, quit).
function M:abandon()
	if self.run and (self.status == "ranked" or self.status == "paused") then
		self.client:call("POST", run_path(self, "abandon"), {}, function() end, true)
	end
	go_local(self, "abandoned")
end

return M
