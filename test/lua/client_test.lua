local client = require "scoreosis.client"

local sent = {}
local reply = {status = 200, body = {display_name = "test-001"}}
local saved
local platform = {
	request = function(url, method, headers, body, done)
		sent[#sent + 1] = {url = url, method = method, headers = headers, body = body}
		done(reply.status, reply.body)
	end,
	encode = function(value) return value end,
	decode = function(value) return value end,
	load_token = function() return saved end,
	save_token = function(token) saved = token end,
}

local c = client.new(platform, "https://scores.example", "sneak", "sneak-web-itch_io-0.2.0")
local result
c:set_name("test-001", function(ok, body) result = {ok, body} end)
assert(#sent == 0 and result[1] == false and result[2].code == "unauthorized", "no token, no request")

saved = "0123.secret"
c = client.new(platform, "https://scores.example", "sneak", "sneak-web-itch_io-0.2.0")
c:profile(function(ok, body) result = {ok, body} end)
local r = sent[#sent]
assert(r.method == "GET" and r.url == "https://scores.example/v1/games/sneak/me/profile")
assert(r.headers.Authorization == "Bearer 0123.secret" and r.body == nil)
assert(result[1] and result[2].display_name == "test-001")

reply.body = {}
c:profile(function(ok, body) result = {ok, body} end)
assert(result[1] and result[2].display_name == nil, "unnamed player")

reply.body = {display_name = "Test-001 A"}
c:set_name("  Test-001  A ", function(ok, body) result = {ok, body} end)
r = sent[#sent]
assert(r.method == "PATCH" and r.url == "https://scores.example/v1/games/sneak/me/profile")
assert(r.body.display_name == "  Test-001  A " and r.headers.Authorization == "Bearer 0123.secret")
assert(result[1] and result[2].display_name == "Test-001 A", "server's canonical name")

for _, case in ipairs({{400, "bad_request"}, {429, "rate_limited"}, {401, "unauthorized"}}) do
	reply.status, reply.body = case[1], {error = {code = case[2], message = "no"}}
	c:set_name("x", function(ok, body) result = {ok, body} end)
	assert(result[1] == false and result[2].code == case[2] and result[2].status == case[1], case[2])
end

reply.status, reply.body = 0, nil
c:set_name("test-001", function(ok, body) result = {ok, body} end)
assert(result[1] == false and result[2].code == "network", "offline")
print("8 profile checks, 0 failures")
