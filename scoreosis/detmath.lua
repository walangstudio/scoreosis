-- Deterministic trigonometry for ranked simulations.
-- Platform math libraries disagree in the last bits; these use only
-- IEEE-exact operations (+ - * / sqrt floor), so every runtime agrees.
local M = {}

local floor = math.floor
local PI = 3.14159265358979311600e+00
local PIO2 = 1.57079632679489655800e+00
local INV_PIO2 = 6.36619772367581382433e-01
local PIO2_1 = 1.57079632673412561417e+00
local PIO2_2 = 6.07710050630396597660e-11
local PIO2_3 = 2.02226624871116645580e-21
local PIO6 = 5.23598775598298815659e-01
local SQRT3 = 1.73205080756887719318e+00
local TAN_PIO12 = 2.67949192431122695616e-01

local function sin_kernel(r)
	local z = r * r
	return r + r * z * (-1.66666666666666324348e-01 + z * (8.33333333332248946124e-03
		+ z * (-1.98412698298579493134e-04 + z * (2.75573137070700676789e-06
		+ z * (-2.50507602534068634195e-08 + z * 1.58969099521155010221e-10)))))
end

local function cos_kernel(r)
	local z = r * r
	return 1 - 0.5 * z + z * z * (4.16666666666666019037e-02 + z * (-1.38888888888741095749e-03
		+ z * (2.48015872894767294178e-05 + z * (-2.75573143513906633035e-07
		+ z * (2.08757232129817482790e-09 + z * -1.13596475577881948265e-11)))))
end

local function reduce(x)
	local k = floor(x * INV_PIO2 + 0.5)
	return ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3, k % 4
end

function M.sin(x)
	local r, q = reduce(x)
	if q == 0 then return sin_kernel(r) end
	if q == 1 then return cos_kernel(r) end
	if q == 2 then return -sin_kernel(r) end
	return -cos_kernel(r)
end

function M.cos(x)
	local r, q = reduce(x)
	if q == 0 then return cos_kernel(r) end
	if q == 1 then return -sin_kernel(r) end
	if q == 2 then return -cos_kernel(r) end
	return sin_kernel(r)
end

local function atan_series(t)
	local z = t * t
	local s = 1 / 29
	for n = 27, 1, -2 do s = 1 / n - z * s end
	return t * s
end

function M.atan(x)
	if x ~= x then return x end
	local negative = x < 0
	if negative then x = -x end
	local invert = x > 1
	if invert then x = 1 / x end
	local result
	if x > TAN_PIO12 then
		result = PIO6 + atan_series((x * SQRT3 - 1) / (x + SQRT3))
	else
		result = atan_series(x)
	end
	if invert then result = PIO2 - result end
	if negative then result = -result end
	return result
end

function M.atan2(y, x)
	if x > 0 then return M.atan(y / x) end
	if x < 0 and y >= 0 then return M.atan(y / x) + PI end
	if x < 0 then return M.atan(y / x) - PI end
	if y > 0 then return PIO2 end
	if y < 0 then return -PIO2 end
	return 0
end

M.pi = PI

return M
