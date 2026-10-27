-- Scoreosis HTTP client. Engine services are injected so the same code runs in
-- Defold (see scoreosis/defold.lua) and in plain Lua tests.
--
-- platform = {
--   request(url, method, headers, body, callback(status, body_string)),
--   encode(table) -> string, decode(string) -> table,
--   load_token() -> string|nil, save_token(string),
-- }
local M = {}
M.__index = M

function M.new(platform, base_url, game_id, build_id, display_name)
	local entries = {}
	for _, entry in ipairs(platform.load_entries and platform.load_entries() or {}) do
		if type(entry) == "table" and type(entry.run_id) == "string"
			and #entry.run_id == 36 and entry.run_id:match("^[%x%-]+$")
			and type(entry.display_name) == "string" and #entry.display_name >= 2 and #entry.display_name <= 16 then
			entries[#entries + 1] = {run_id=entry.run_id, display_name=entry.display_name}
		end
	end
	return setmetatable({
		platform = platform,
		base_url = base_url,
		game_id = game_id,
		build_id = build_id,
		-- Build ids are <game>-<runtime>-<channel>-<version>.
		runtime = build_id:match("^[^-]+%-([^-]+)%-[^-]+%-.+$"),
		token = platform.load_token(),
		display_name = display_name,
		entries = entries,
	}, M)
end

-- callback(ok, body_or_error). Errors are { code = "...", message = "...", status = n }.
function M:call(method, path, body, callback, private)
	local local_url = self.base_url:match("^http://127%.0%.0%.1:%d+/?$")
		or self.base_url:match("^http://localhost:%d+/?$")
	if not self.base_url:match("^https://") and not (self.platform.allow_http and local_url) then
		callback(false, { code = "insecure_url", message = "HTTPS is required", status = 0 })
		return
	end
	local headers = body and { ["Content-Type"] = "application/json" } or {}
	if private then
		if not self.token then
			callback(false, { code = "unauthorized", message = "no guest token", status = 0 })
			return
		end
		headers["Authorization"] = "Bearer " .. self.token
	end
	local payload = body and self.platform.encode(body) or nil
	self.platform.request(self.base_url .. path, method, headers, payload, function(status, text)
		local ok, decoded = pcall(self.platform.decode, text or "")
		if not ok or type(decoded) ~= "table" then decoded = {} end
		if status >= 200 and status < 300 then
			callback(true, decoded)
		else
			local err = decoded.error or {}
			callback(false, {
				code = err.code or (status == 0 and "network" or "http_" .. status),
				message = err.message or "request failed",
				details = err.details,
				status = status,
			})
		end
	end)
end

function M:game_path(suffix)
	return "/v1/games/" .. self.game_id .. suffix
end

-- Creates the installation's guest on first use; later calls reuse the saved token.
function M:ensure_guest(callback)
	if self.token then
		callback(true)
		return
	end
	if self.registering then
		self.registering[#self.registering + 1] = callback
		return
	end
	self.registering = {callback}
	self:call("POST", "/v1/guests", { game_id = self.game_id, build_id = self.build_id }, function(ok, body)
		local waiting = self.registering
		self.registering = nil
		local created = ok and type(body.token) == "string"
		if created then
			self.token = body.token
			self.platform.save_token(body.token)
		end
		for _, done in ipairs(waiting) do done(created, not created and body or nil) end
	end)
end

-- filters: { board, mode, country, runtime, channel, page, me }. Platforms never
-- mix: runtime defaults to this build's own.
function M:leaderboard(filters, callback)
	if not self.arcade and self.display_name and (self.synced_name ~= self.display_name or self.synced_token ~= self.token) then
		return self:ensure_player(function(ok, err)
			if ok then self:leaderboard(filters, callback) else callback(false, err) end
		end)
	end
	local query = {}
	for _, key in ipairs({ "board", "mode", "country", "runtime", "channel", "page" }) do
		local value = filters[key]
		if key == "runtime" and value == nil then value = self.runtime end
		if value ~= nil then query[#query + 1] = key .. "=" .. tostring(value) end
	end
	local personal = (self.arcade or filters.me or self.display_name ~= nil) and self.token ~= nil
	if personal then query[#query + 1] = "me=1" end
	local path = self:game_path("/leaderboards") .. (#query > 0 and "?" .. table.concat(query, "&") or "")
	self:call("GET", path, nil, callback, personal)
end

function M:achievements(callback)
	self:call("GET", self:game_path("/me/achievements"), nil, callback, true)
end

-- callback(ok, { display_name = name or nil }); nil means the player has not chosen one.
function M:profile(callback)
	self:call("GET", self:game_path("/me/profile"), nil, callback, true)
end

-- Saves the player's public name (2-16 letters, digits, single spaces or hyphens).
-- callback(ok, { display_name = saved }) or (false, { code = "bad_request" | "rate_limited" | ... }).
function M:set_name(name, callback)
	self:call("PATCH", self:game_path("/me/profile"), { display_name = name }, callback, true)
end

function M:ensure_player(callback)
	self:ensure_guest(function(ok, err)
		if not ok then return callback(false, err) end
		local name, token = self.display_name, self.token
		if not name or self.synced_name == name and self.synced_token == token then return callback(true) end
		if self.naming then
			self.naming[#self.naming + 1] = callback
			return
		end
		self.naming = {callback}
		self:set_name(name, function(saved, body)
			if saved and (type(body.display_name) ~= "string" or body.display_name == "") then
				saved, body = false, {code="invalid_response",message="Name was not confirmed",status=0}
			end
			local waiting = self.naming
			self.naming = nil
			if saved then self.synced_name, self.synced_token = name, token end
			for _, done in ipairs(waiting) do
				if saved and (self.display_name ~= name or self.token ~= token) then self:ensure_player(done)
				else done(saved, body) end
			end
		end)
	end)
end

function M:platform_best(callback)
	self:leaderboard({}, function(ok, body)
		if not ok or type(body.entries) ~= "table" then return callback(false) end
		local first = body.entries[1]
		if first ~= nil and (type(first) ~= "table" or type(first.score) ~= "number"
			or not (first.score >= 0 and first.score % 1 == 0)) then return callback(false) end
		callback(true, first and first.score or 0)
	end)
end

function M:queue_entry(run_id, name)
	for _, entry in ipairs(self.entries) do
		if entry.run_id == run_id then return entry.display_name == name end
	end
	self.entries[#self.entries + 1] = {run_id=run_id, display_name=name}
	return not self.platform.save_entries or self.platform.save_entries(self.entries)
end

-- The queue belongs to the client, so leaving game over cannot cancel delivery.
function M:update_entries(now)
	if self.finishing then
		self.finishing:update()
		if self.finishing.status ~= "finishing" then self.finishing = nil end
	end
	if self.entry_request or #self.entries == 0 or now < (self.entry_retry_at or 0) then return end
	local entry = self.entries[1]
	self.entry_request = true
	self:call("POST", self:game_path("/runs/" .. entry.run_id .. "/entry"), {display_name=entry.display_name}, function(ok, body)
		self.entry_request = false
		if ok and body.display_name ~= entry.display_name then
			ok, body = false, {code="invalid_response", status=0}
		end
		local retry = not ok and (body.status == 0 or body.status == 429 or body.status >= 500 or body.code == "run_not_active")
		if not retry then
			table.remove(self.entries, 1)
			if self.platform.save_entries then self.platform.save_entries(self.entries) end
			self.entry_attempts = 0
		else
			table.remove(self.entries, 1)
			self.entries[#self.entries + 1] = entry
			if self.platform.save_entries then self.platform.save_entries(self.entries) end
			self.entry_attempts = math.min((self.entry_attempts or 0) + 1, 5)
		end
		self.entry_retry_at = now + (retry and 2 ^ self.entry_attempts or 0)
		self.entry_error = not ok and body.code or nil
		if self.on_entry_result then self.on_entry_result(ok, entry.run_id, body) end
	end, true)
end

return M
