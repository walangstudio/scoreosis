local client = require "scoreosis.client"
local requests = {}
local platform = {
	request=function(url,method,headers,body,done)
		requests[#requests+1]={url=url,method=method,headers=headers,body=body,done=done}
	end,
	encode=function(value) return value end,
	decode=function(value) return value end,
	load_token=function() end,
	save_token=function() end,
}
local function answer(status, body)
	local request=table.remove(requests,1)
	assert(request,"no pending request")
	request.done(status,body)
	return request
end
local c=client.new(platform,"https://scores.example","sneak","sneak-web-itch_io-0.2.0","KITTY")
local completed=0
for _=1,2 do c:ensure_player(function(ok) assert(ok); completed=completed+1 end) end
assert(#requests==1 and requests[1].url:find("/v1/guests",1,true))
answer(201,{token="player.secret"})
assert(#requests==1 and requests[1].method=="PATCH" and requests[1].body.display_name=="KITTY")
assert(requests[1].headers.Authorization=="Bearer player.secret")
answer(200,{display_name="KITTY"})
assert(completed==2)
c:ensure_player(function(ok) assert(ok); completed=completed+1 end)
assert(completed==3 and #requests==0)
c:leaderboard({runtime="web"},function(ok,body) assert(ok and body.entries[1].score==2) end)
assert(requests[1].url:find("runtime=web",1,true) and requests[1].url:find("me=1",1,true))
assert(requests[1].headers.Authorization=="Bearer player.secret")
answer(200,{entries={{name="KITTY",score=2,rank=1}}})
c.token="replacement.secret"
local failed
c:ensure_player(function(ok,err) failed=not ok and err.code=="rate_limited" end)
assert(requests[1].method=="PATCH")
answer(429,{error={code="rate_limited"}})
assert(failed and c.synced_token~="replacement.secret")
c:ensure_player(function(ok) assert(ok) end)
answer(200,{display_name="KITTY"})
assert(c.synced_token=="replacement.secret")
c.display_name="NINJA"
c:ensure_player(function(ok) assert(ok) end)
c.display_name="CAT"
c:ensure_player(function(ok) assert(ok) end)
answer(200,{display_name="NINJA"})
assert(#requests==1 and requests[1].body.display_name=="CAT")
answer(200,{display_name="CAT"})
assert(c.synced_name=="CAT" and #requests==0)
c.display_name="UNKNOWN"
c:ensure_player(function(ok,err) assert(not ok and err.code=="invalid_response") end)
answer(200,{})
assert(c.synced_name=="CAT")
print("IDENTITY_TEST registration, name sync, private reads, coalescing and retry: PASS")
