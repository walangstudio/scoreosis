-- Canonical, exact encoding of plain Lua data, shared by game clients and the
-- Scoreosis verifier. Numbers round-trip bit for bit; table keys are sorted,
-- so equal states always encode to equal strings.
local M = {}

local floor, frexp, ldexp, format = math.floor, math.frexp, math.ldexp, string.format
local concat, sort, byte, sub, find = table.concat, table.sort, string.byte, string.sub, string.find
local TWO53 = 9007199254740992
local NEG_ZERO = -1 / math.huge

local function encode_number(x)
	if x ~= x then return "N" end
	if x == math.huge then return "I" end
	if x == -math.huge then return "J" end
	if x == floor(x) and x > -TWO53 and x < TWO53 then
		if x == 0 and 1 / x < 0 then return "m" end
		return "i" .. format("%.0f", x) .. ";"
	end
	local m, e = frexp(x)
	return "f" .. format("%.0f", m * TWO53) .. "," .. format("%.0f", e - 53) .. ";"
end

local function key_less(a, b)
	local ta, tb = type(a), type(b)
	if ta ~= tb then return ta < tb end
	return a < b
end

local encode_value

local function encode_table(t, out, depth)
	if depth > 64 then error("codec: nesting too deep") end
	local keys = {}
	for k in pairs(t) do
		local kt = type(k)
		if kt ~= "string" and kt ~= "number" then error("codec: unsupported key type " .. kt) end
		keys[#keys + 1] = k
	end
	sort(keys, key_less)
	out[#out + 1] = "{"
	for i = 1, #keys do
		local k = keys[i]
		encode_value(k, out, depth)
		encode_value(t[k], out, depth)
	end
	out[#out + 1] = "}"
end

function encode_value(v, out, depth)
	local tv = type(v)
	if tv == "number" then
		out[#out + 1] = encode_number(v)
	elseif tv == "string" then
		out[#out + 1] = "s" .. #v .. ":" .. v
	elseif tv == "boolean" then
		out[#out + 1] = v and "t" or "b"
	elseif tv == "table" then
		encode_table(v, out, depth + 1)
	else
		error("codec: unsupported value type " .. tv)
	end
end

function M.encode(v)
	local out = {}
	encode_value(v, out, 0)
	return concat(out)
end

local function read_until(s, pos, ch)
	local stop = find(s, ch, pos, true)
	if not stop then error("codec: truncated input") end
	return sub(s, pos, stop - 1), stop + 1
end

local decode_value

function decode_value(s, pos, depth)
	local tag = sub(s, pos, pos)
	pos = pos + 1
	if tag == "i" then
		local digits, nxt = read_until(s, pos, ";")
		return tonumber(digits), nxt
	elseif tag == "f" then
		local body, nxt = read_until(s, pos, ";")
		local comma = find(body, ",", 1, true)
		return ldexp(tonumber(sub(body, 1, comma - 1)), tonumber(sub(body, comma + 1))), nxt
	elseif tag == "m" then
		return NEG_ZERO, pos
	elseif tag == "N" then
		return 0 / 0, pos
	elseif tag == "I" then
		return math.huge, pos
	elseif tag == "J" then
		return -math.huge, pos
	elseif tag == "t" then
		return true, pos
	elseif tag == "b" then
		return false, pos
	elseif tag == "s" then
		local len, start = read_until(s, pos, ":")
		local n = tonumber(len)
		return sub(s, start, start + n - 1), start + n
	elseif tag == "{" then
		if depth > 64 then error("codec: nesting too deep") end
		local t = {}
		while sub(s, pos, pos) ~= "}" do
			if pos > #s then error("codec: truncated input") end
			local k, v
			k, pos = decode_value(s, pos, depth + 1)
			v, pos = decode_value(s, pos, depth + 1)
			t[k] = v
		end
		return t, pos + 1
	end
	error("codec: bad tag at " .. (pos - 1))
end

function M.decode(s)
	local v, pos = decode_value(s, 1, 0)
	if pos ~= #s + 1 then error("codec: trailing data") end
	return v
end

-- Polynomial checksum mod 2^31-1; exact in doubles, needs no bit library.
function M.checksum(s)
	local h = 7
	for i = 1, #s, 64 do
		local chunk = { byte(s, i, i + 63) }
		for j = 1, #chunk do h = (h * 257 + chunk[j]) % 2147483647 end
	end
	return h
end

-- Inputs travel as "count:bits,count:bits" run-length pairs, one bitmask per tick.
function M.encode_inputs(ticks)
	local out, run, last = {}, 0, nil
	for i = 1, #ticks do
		local bits = ticks[i]
		if bits == last then
			run = run + 1
		else
			if last then out[#out + 1] = run .. ":" .. last end
			last, run = bits, 1
		end
	end
	if last then out[#out + 1] = run .. ":" .. last end
	return concat(out, ",")
end

return M
