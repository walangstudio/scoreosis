-- Server side of ranked contract v1. Entry points take and return strings.
local codec = require "scoreosis.codec"

local game, sim, tick, max_bits

local function status()
	local finished = game.finished(sim) and 1 or 0
	return tick .. "|" .. finished .. "|" .. codec.checksum(codec.encode(game.save(sim)))
end

local function open(name)
	game = require(name)
	if game.contract ~= 1 then error("unsupported ranked contract") end
	max_bits = 2 ^ game.buttons - 1
end

-- "module|seed" or "module|seed|mode"
function sv_start(arg)
	local name, seed, mode = string.match(arg, "^([%w_%.]+)|(%d+)|([%w_]+)$")
	if not name then name, seed = string.match(arg, "^([%w_%.]+)|(%d+)$") end
	if not name then error("bad start argument") end
	open(name)
	sim = game.new(tonumber(seed), mode)
	tick = 0
	return status()
end

-- "count:bits,count:bits,..."; stops at the terminal tick or when the caller's
-- soft instruction budget runs out. The returned tick tells the caller how much
-- input was consumed.
function sv_steps(arg)
	for count, bits in string.gmatch(arg, "(%d+):(%d+)") do
		count, bits = tonumber(count), tonumber(bits)
		if count < 1 or bits > max_bits then error("bad input run") end
		for _ = 1, count do
			if game.finished(sim) or sv_soft_exhausted() then return status() end
			game.step(sim, bits)
			tick = tick + 1
		end
	end
	return status()
end

function sv_status()
	return status()
end

function sv_save()
	return codec.encode({ tick = tick, sim = game.save(sim) })
end

-- "module|<encoded checkpoint>"
function sv_load(arg)
	local bar = string.find(arg, "|", 1, true)
	open(string.sub(arg, 1, bar - 1))
	local data = codec.decode(string.sub(arg, bar + 1))
	tick = data.tick
	sim = game.load(data.sim)
	return status()
end

-- One "name=value" line per fact; values are integers.
function sv_facts()
	local facts = game.facts(sim)
	local names = {}
	for name, value in pairs(facts) do
		if type(value) ~= "number" or value ~= math.floor(value) or value ~= value then
			error("fact " .. tostring(name) .. " is not an integer")
		end
		names[#names + 1] = name
	end
	table.sort(names)
	local out = {}
	for i = 1, #names do out[i] = names[i] .. "=" .. string.format("%.0f", facts[names[i]]) end
	return table.concat(out, "\n")
end

-- Optional M.modes: one board per mode, chosen when a run starts. Comma-separated.
function sv_modes(name)
	open(name)
	return table.concat(game.modes or {}, ",")
end

function sv_buttons(name)
	open(name)
	return tostring(game.buttons)
end

-- Achievement catalog declared by the game module, one tab-separated line each.
function sv_catalog(name)
	open(name)
	local out = {}
	for i, a in ipairs(game.achievements or {}) do
		out[i] = table.concat({ a.id, a.fact, a.mode, string.format("%.0f", a.gte), a.name, a.description }, "\t")
	end
	return table.concat(out, "\n")
end
