-- Local achievement progress, evaluated exactly like the server's verified
-- progress: "run" achievements use the best single run, "total" ones the sum.
-- Store the record table in the game's own save; it never becomes verified.
local M = {}

function M.new_record()
	return { best = {}, total = {}, unlocked = {} }
end

-- Applies one finished run's facts; returns ids unlocked by it.
function M.apply(record, specs, facts)
	local seen = {}
	for _, spec in ipairs(specs) do
		local fact = spec.fact
		if not seen[spec.mode .. fact] then
			seen[spec.mode .. fact] = true
			local value = facts[fact] or 0
			if spec.mode == "run" then
				record.best[fact] = math.max(record.best[fact] or 0, value)
			else
				record.total[fact] = (record.total[fact] or 0) + value
			end
		end
	end
	local unlocked = {}
	for _, spec in ipairs(specs) do
		if not record.unlocked[spec.id] and M.current(record, spec) >= spec.gte then
			record.unlocked[spec.id] = true
			unlocked[#unlocked + 1] = spec.id
		end
	end
	return unlocked
end

function M.current(record, spec)
	local source = spec.mode == "run" and record.best or record.total
	return source[spec.fact] or 0
end

return M
