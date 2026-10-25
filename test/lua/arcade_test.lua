local client = require "scoreosis.client"
local session = require "scoreosis.session"
local saved, requests = {}, {}
local function copy(entries)
	local result = {}
	for _, e in ipairs(entries) do result[#result + 1] = {run_id=e.run_id, display_name=e.display_name} end
	return result
end
local platform = {
	request = function(url, method, headers, body, done)
		assert(method ~= "PATCH", "arcade never edits profiles")
		requests[#requests + 1] = {url=url, body=body, done=done}
	end,
	encode = function(v) return v end, decode = function(v) return v end,
	load_token = function() return "token" end, save_token = function() end,
	load_entries = function() return copy(saved) end,
	save_entries = function(entries) saved = copy(entries); return true end,
}
local function new()
	local c = client.new(platform, "https://scores.test", "sneak", "sneak-web-itch_io-0.2.0", "TEST-009")
	c.arcade = true
	return c
end
local c = new()
local a, b = "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"
assert(c:queue_entry(a, "TEST-001"))
assert(not c:queue_entry(a, "TEST-002"), "pending names cannot change")
assert(c:queue_entry(b, "TEST-002"))
c:update_entries(10)
c:update_entries(11)
assert(#requests == 1, "one request in flight")
requests[1].done(409, {error={code="run_not_active"}})
c:update_entries(12)
assert(requests[2].url:find(b, 1, true), "pending verification cannot block another entry")
requests[2].done(200, {display_name="TEST-002"})
c = new()
assert(#c.entries == 1 and c.entries[1].run_id == a, "queue survives restart")
c:update_entries(15)
requests[3].done(0, {})
c:update_entries(17)
assert(requests[4].body.display_name == "TEST-001", "lost reply retries identical entry")
requests[4].done(200, {display_name="TEST-001"})
assert(#saved == 0 and #c.entries == 0)
c:leaderboard({}, function() end)
assert(requests[5].url:find("me=1", 1, true), "arcade reads bypass stale public cache")
requests[5].done(200, {entries={}})
local s = session.new(c, {new=function(seed) return {seed=seed} end}, function() return 0 end)
s:start(function(ok) assert(ok) end)
assert(requests[6].body.arcade == true)
requests[6].done(201, {run_id=a, seed=123, arcade=true})
assert(s.status == "ranked", "new games start without profile synchronization")
c:queue_entry(a, "TEST-003")
c:update_entries(20)
requests[7].done(409, {error={code="entry_locked"}})
assert(#saved == 0, "permanent rejections do not retry")
print("8 arcade queue checks, 0 failures")
