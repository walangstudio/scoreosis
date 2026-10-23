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

function M.new(platform, base_url, game_id, build_id)
	return setmetatable({
		platform = platform,
		base_url = base_url,
		game_id = game_id,
		build_id = build_id,
		-- Build ids are <game>-<runtime>-<channel>-<version>.
		runtime = build_id:match("^[^-]+%-([^-]+)%-[^-]+%-.+$"),
		token = platform.load_token(),
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
	local query = {}
	for _, key in ipairs({ "board", "mode", "country", "runtime", "channel", "page" }) do
		local value = filters[key]
		if key == "runtime" and value == nil then value = self.runtime end
		if value ~= nil then query[#query + 1] = key .. "=" .. tostring(value) end
	end
	if filters.me and self.token then query[#query + 1] = "me=1" end
	local path = self:game_path("/leaderboards") .. (#query > 0 and "?" .. table.concat(query, "&") or "")
	self:call("GET", path, nil, callback, filters.me and self.token ~= nil)
end

function M:achievements(callback)
	self:call("GET", self:game_path("/me/achievements"), nil, callback, true)
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

return M
