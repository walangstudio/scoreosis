local M = {}

function M.start(session, clock, callback)
	local pending, deadline, waiting = true, nil, nil
	local function settle(ok, notify)
		if not pending then return end
		pending = false
		clock.cancel(deadline)
		if waiting then clock.cancel(waiting) end
		if not ok then session:abandon() end
		if notify then callback(ok and session or nil) end
	end
	-- Registration, public-name sync and run creation require separate round trips.
	deadline = clock.delay(8, false, function() settle(false, true) end)
	local function start()
		waiting = nil
		if not pending then return end
		if session.client and session.client.finishing then
			waiting = clock.delay(0.1, false, start)
		else
			session:start(function(ok) settle(ok, true) end)
		end
	end
	start()
	return function() settle(false, false) end
end

return M
