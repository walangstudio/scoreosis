local M = {}

function M.start(session, clock, callback)
	local pending, deadline = true, nil
	local function settle(ok, notify)
		if not pending then return end
		pending = false
		clock.cancel(deadline)
		if not ok then session:abandon() end
		if notify then callback(ok and session or nil) end
	end
	-- Registration, public-name sync and run creation require separate round trips.
	deadline = clock.delay(8, false, function() settle(false, true) end)
	session:start(function(ok) settle(ok, true) end)
	return function() settle(false, false) end
end

return M
