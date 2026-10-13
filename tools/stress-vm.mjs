// Worst-case verifier cost for Ah!Steroids: asteroids held at the cap, both ships
// in steroid overdrive and immortal. Usage: node tools/stress-vm.mjs <bundle.json> [seconds]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuaVm } from '../src/vm/host.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [bundlePath, secondsArg = '120'] = process.argv.slice(2);
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
const stress = `
local ranked = require "game.ranked"
local simulation = require "game.simulation"
local cfg = require "game.config"
local M = {}
for k, v in pairs(ranked) do M[k] = v end
function M.step(sim, bits)
	local state = sim.state
	state.planet_integrity, state.status = 100, "playing"
	for _, ship in ipairs(state.ships) do
		ship.alive = true
		ship.weapon, ship.weapon_timer = "steroid", 5
	end
	local i = 0
	while #state.asteroids < cfg.limits.asteroids do
		i = i + 1
		simulation.spawn_asteroid(state, "large", 100 + (i * 37) % 1700, 60 + (i * 53) % 900, 0, 0)
	end
	ranked.step(sim, bits)
	sim.peak_asteroids = math.max(sim.peak_asteroids or 0, #state.asteroids)
	sim.peak_bullets = math.max(sim.peak_bullets or 0, #state.bullets)
end
function M.finished() return false end
function M.facts(sim)
	return { asteroids = sim.peak_asteroids or 0, bullets = sim.peak_bullets or 0 }
end
return M`;
const vm = await LuaVm.create({
  wasm: new WebAssembly.Module(readFileSync(join(root, 'src', 'vm', 'lua51.wasm'))),
  driver: readFileSync(join(root, 'src', 'vm', 'driver.lua'), 'utf8'),
  modules: { ...bundle.modules, 'stress.ranked': stress },
  limits: { memory: 32 << 20, instructions: 1e9 },
});
vm.call('sv_start', 'stress.ranked|7');
const times = [];
const instr = [];
let checkpoint = 0;
for (let s = 0; s < Number(secondsArg); s++) {
  const t0 = performance.now();
  vm.call('sv_steps', '30:5,30:10');
  instr.push(vm.lastInstructions());
  times.push(performance.now() - t0);
  checkpoint = Math.max(checkpoint, vm.call('sv_save').length);
}
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(1);
console.log(`stress ms per second of play: p50 ${pct(0.5)} p95 ${pct(0.95)} max ${pct(1)}`);
const total = (xs) => xs.reduce((a, b) => a + b, 0);
console.log(
  `instructions per ms: ${(total(instr) / total(times)).toFixed(0)}, per second of play p50 ${instr.sort((a, b) => a - b)[instr.length >> 1]}`,
);
console.log('peaks:', vm.call('sv_facts').replace(/\n/g, ' '));
console.log(
  `heap ${(vm.memoryUsed() / 1024).toFixed(0)} KiB, largest checkpoint ${(checkpoint / 1024).toFixed(1)} KiB`,
);
