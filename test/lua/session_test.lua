-- Unit tests for scoreosis.session and scoreosis.progress with a scripted server.
-- Run: python tools/test-lua.py
local client_mod = require "scoreosis.client"
local session_mod = require "scoreosis.session"
local progress = require "scoreosis.progress"
local codec = require "scoreosis.codec"

local tests, failures = 0, 0
local function test(name, fn)
	tests = tests + 1
	local ok, err = pcall(fn)
	if not ok then
		failures = failures + 1
		print("FAIL " .. name .. ": " .. tostring(err))
	end
end
local function eq(a, b, msg)
	if a ~= b then error((msg or "") .. " expected " .. tostring(b) .. " got " .. tostring(a), 2) end
end

-- A toy ranked game: score counts ticks with bit 1 held; ends at tick `length`.
local function toy(length)
	return {
		contract = 1,
		buttons = 2,
		new = function(seed) return { seed = seed, tick = 0, score = 0 } end,
		step = function(sim, bits)
			sim.tick = sim.tick + 1
			if bits % 2 == 1 then sim.score = sim.score + 1 end
		end,
		finished = function(sim) return sim.tick >= length end,
		facts = function(sim) return { score = sim.score } end,
		save = function(sim) return { seed = sim.seed, tick = sim.tick, score = sim.score } end,
		load = function(d) return { seed = d.seed, tick = d.tick, score = d.score } end,
	}
end

-- Requests queue until the test answers them.
local function fake()
	local f = { requests = {}, token = nil, time = 1000 }
	f.platform = {
		request = function(url, method, headers, body, cb)
			f.requests[#f.requests + 1] = { url = url, method = method, headers = headers, body = body, cb = cb }
		end,
		encode = function(t) return t end,
		decode = function(t) return t end,
		load_token = function() return f.token end,
		save_token = function(t) f.token = t end,
	}
	function f.answer(status, body)
		local r = table.remove(f.requests, 1)
		assert(r, "no pending request")
		r.cb(status, body)
		return r
	end
	f.now = function() return f.time end
	return f
end

local function started(length)
	local f = fake()
	f.token = "tok"
	local c = client_mod.new(f.platform, "https://x", "toy", "toy-dev")
	local s = session_mod.new(c, toy(length or 600), f.now)
	local ok
	s:start(function(v) ok = v end)
	f.answer(201, { run_id = "r1", seed = 9 })
	assert(ok, "start failed")
	return f, s
end

local function play(f, s, seconds, bits)
	for _ = 1, seconds * 60 do
		f.time = f.time + 1 / 60
		for _ = 1, s:due() do s:step(bits or 1) end
	end
end

test("creates and saves a guest before the first run", function()
	local f = fake()
	local c = client_mod.new(f.platform, "https://x", "toy", "toy-dev")
	local s = session_mod.new(c, toy(600), f.now)
	s:start(function() end)
	local guest = f.answer(201, { token = "new-token" })
	eq(guest.url, "https://x/v1/guests")
	eq(f.token, "new-token")
	local run = f.answer(201, { run_id = "r1", seed = 3 })
	eq(run.headers.Authorization, "Bearer new-token")
	eq(s.status, "ranked")
	eq(s.sim.seed, 3)
end)

test("paces ticks by wall clock and sends one checksummed chunk per second", function()
	local f, s = started()
	play(f, s, 1)
	eq(s.tick, 60)
	eq(#f.requests, 1)
	local body = f.requests[1].body
	eq(body.seq, 0)
	eq(body.from_tick, 0)
	eq(body.inputs, "60:1")
	eq(body.checksum, codec.checksum(codec.encode({ seed = 9, tick = 60, score = 60 })))
end)

test("keeps one request in flight and batches the backlog", function()
	local f, s = started()
	play(f, s, 2)
	eq(#f.requests, 1, "second chunk must wait")
	f.answer(200, { status = "active" })
	eq(#f.requests, 1)
	eq(f.requests[1].body.seq, 1)
	eq(f.requests[1].body.from_tick, 60)
end)

test("retries a failed upload with the identical body", function()
	local f, s = started()
	play(f, s, 1)
	local first = f.answer(0, nil)
	eq(#f.requests, 1)
	eq(f.requests[1].body, first.body)
	eq(s.status, "ranked")
end)

test("goes local when the server rejects a chunk, and keeps playing", function()
	local f, s = started()
	play(f, s, 1)
	f.answer(422, { error = { code = "timing_rejected", message = "late" } })
	eq(s.status, "local")
	eq(s.reason, "timing_rejected")
	play(f, s, 1)
	eq(s.tick, 120)
	eq(#f.requests, 0)
end)

test("drains partial input before pausing and resumes on the server baseline", function()
	local f, s = started()
	play(f, s, 1.5)
	local paused
	s:pause(function(ok) paused = ok end)
	f.answer(200, { status = "active" })
	eq(f.requests[1].body.inputs, "30:1", "partial chunk flushed")
	f.answer(200, { status = "active" })
	local p = f.answer(200, { status = "paused" })
	eq(p.body.tick, 90)
	eq(paused, true)
	f.time = f.time + 300
	eq(s:due(), 0)
	local resumed
	s:resume(function(ok) resumed = ok end)
	eq(s:due(), 0, "no ticks until the server answers")
	f.answer(200, { status = "active" })
	eq(resumed, true)
	f.time = f.time + 0.5
	eq(s:due(), 8)
end)

test("finishes after the chunk in flight lands and polls while verifying", function()
	local f, s = started(90)
	local result
	s.on_result = function(sess) result = sess end
	play(f, s, 2)
	eq(s.tick, 90)
	eq(s.status, "finishing")
	f.answer(200, { status = "active" })
	eq(f.requests[1].body.from_tick, 60)
	eq(f.requests[1].body.inputs, "30:1")
	f.answer(200, { status = "verifying" })
	eq(f.requests[1].url, "https://x/v1/games/toy/runs/r1/finish")
	f.answer(200, { status = "verifying", retry_after_ms = 1000 })
	f.time = f.time + 1.1
	s:update()
	f.answer(200, { status = "finished", score = 90, unlocked = {} })
	eq(s.status, "verified")
	eq(result.result.score, 90)
end)

test("a failed pause leaves the run local and still answers the caller", function()
	local f, s = started()
	play(f, s, 1)
	local answered
	s:pause(function(ok) answered = ok end)
	f.answer(409, { error = { code = "run_not_active", details = { reason = "connection_lost" } } })
	eq(answered, false)
	eq(s.status, "local")
	eq(s.reason, "connection_lost")
end)

test("local progress mirrors best-run and total semantics", function()
	local specs = {
		{ id = "best", fact = "score", mode = "run", gte = 100 },
		{ id = "sum", fact = "kills", mode = "total", gte = 10 },
	}
	local r = progress.new_record()
	eq(#progress.apply(r, specs, { score = 99, kills = 6 }), 0)
	local unlocked = progress.apply(r, specs, { score = 50, kills = 4 })
	eq(unlocked[1], "sum")
	eq(r.best.score, 99)
	eq(progress.apply(r, specs, { score = 100, kills = 0 })[1], "best")
	eq(#progress.apply(r, specs, { score = 500, kills = 50 }), 0, "unlocks once")
end)

test("codec round-trips awkward numbers exactly", function()
	local values = { 0.1, -0.0, 1e300, -2.5e-310, 2 ^ 53 + 2, 1 / 3, -7, 0 }
	for _, v in ipairs(values) do
		local back = codec.decode(codec.encode(v))
		eq(back, v)
		eq(1 / back, 1 / v, "sign of zero")
	end
	local t = { b = { 1, 2, { x = "y" } }, a = true, [3] = false }
	eq(codec.encode(codec.decode(codec.encode(t))), codec.encode(t))
end)

print(string.format("%d tests, %d failures", tests, failures))
if failures > 0 then error("lua tests failed") end
