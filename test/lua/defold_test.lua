local requests, configured = 0, 0
local system, pem, initialized = "Windows", "public roots", true
sys = {
	get_save_file = function(_, file) return file end,
	get_sys_info = function() return {system_name = system} end,
	get_engine_info = function() return {is_debug = false} end,
	load_resource = function(path) assert(path == "/scoreosis/cacert.pem"); return pem end,
	load = function() return {} end,
	save = function() end,
}
json = {encode = function(value) return value end, decode = function(value) return value end}
socket = {gettime = function() return 0 end}
http = {request = function(_, _, done)
	requests = requests + 1
	done(nil, nil, {status = 200, response = "ok"})
end}
local tls = {configure = function(value)
	assert(value == pem)
	configured = configured + 1
	return initialized
end}
local function attempt(expected, reason)
	package.loaded["scoreosis.defold"] = nil
	local defold = require "scoreosis.defold"
	local before = requests
	defold.platform("toy").request("https://scores.example", "GET", {}, nil, function(status, body)
		assert(status == expected, reason)
		if status == 0 then assert(body.error.code == "tls_unavailable", reason) end
	end)
	assert(requests == before + (expected == 200 and 1 or 0), reason)
	local count = configured
	defold.platform("another-client")
	assert(configured == count, "multiple clients must not reset roots during in-flight requests")
end

scoreosis_tls = nil
attempt(0, "missing extension must not send credentials")
scoreosis_tls = tls
initialized = false
attempt(0, "failed certificate initialization must not send credentials")
initialized, pem = true, nil
attempt(0, "missing bundle must not send credentials")
pem = "public roots"
attempt(200, "initialized native transport sends requests")
assert(configured == 2)
system, scoreosis_tls = "HTML5", nil
attempt(200, "web transport uses browser certificate verification")
print("5 transport checks, 0 failures")
