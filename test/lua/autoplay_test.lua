local autoplay = require "scoreosis.autoplay"

local function setup()
	local f = {results = {}, abandoned = 0, cancelled = 0}
	f.session = {
		start = function(_, done) f.reply = done end,
		abandon = function() f.abandoned = f.abandoned + 1 end,
	}
	f.clock = {
		delay = function(seconds, repeating, done)
			assert(seconds <= 10 and not repeating)
			f.seconds = seconds
			f.timeout = done
			return 42
		end,
		cancel = function(id) assert(id == 42); f.cancelled = f.cancelled + 1 end,
	}
	f.cancel = autoplay.start(f.session, f.clock, function(session)
		f.results[#f.results + 1] = session or false
	end)
	return f
end

local f = setup()
f.reply(true)
assert(f.results[1] == f.session and f.cancelled == 1 and f.abandoned == 0)
f.timeout()
assert(#f.results == 1)

f = setup()
f.reply(false)
assert(f.results[1] == false and f.abandoned == 1)

f = setup()
f.timeout()
assert(f.results[1] == false and f.abandoned == 1)
f.reply(true)
assert(#f.results == 1, "a late start must not replace local play")

f = setup()
if f.seconds <= 4 then f.timeout() end
f.reply(true)
assert(f.results[1] == f.session, "normal multi-request startup must not become local after two seconds")

f = setup()
f.cancel()
f.reply(true)
f.timeout()
assert(#f.results == 0 and f.abandoned == 1, "leaving a pending play must not start a game")
print("7 automatic play checks, 0 failures")
