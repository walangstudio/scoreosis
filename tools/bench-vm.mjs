// Runs a packed ruleset in the Wasm VM under Node and reports cost per second of play.
// Usage: node tools/bench-vm.mjs games/<id>/rulesets/<ruleset>.json [seed] [maxSeconds]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuaVm } from '../src/vm/host.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [bundlePath, seedArg = '12345', secondsArg = '600'] = process.argv.slice(2);
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
const wasm = new WebAssembly.Module(readFileSync(join(root, 'src', 'vm', 'lua51.wasm')));
const driver = readFileSync(join(root, 'src', 'vm', 'driver.lua'), 'utf8');
const options = {
  wasm,
  driver,
  modules: bundle.modules,
  limits: { memory: 32 << 20, instructions: 50e6 },
};

let rng = Number(seedArg);
const nextBits = () => {
  rng = (rng * 48271) % 2147483647;
  return rng % 16;
};
const chunk = () => {
  const runs = [];
  for (let i = 0; i < 3; i++) runs.push(`20:${nextBits()}`);
  return runs.join(',');
};

const vm = await LuaVm.create(options);
vm.call('sv_start', `${bundle.entry}|${seedArg}`);
const times = [];
let status = '';
let checkpoint = '';
let replay = [];
for (let s = 0; s < Number(secondsArg); s++) {
  const input = chunk();
  const t0 = performance.now();
  status = vm.call('sv_steps', input);
  times.push(performance.now() - t0);
  if (s === 30) {
    checkpoint = vm.call('sv_save');
    replay = [];
  } else if (s > 30) {
    replay.push([input, status]);
  }
  if (status.split('|')[1] === '1') break;
}
times.sort((a, b) => a - b);
const pct = (p) => times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(2);
console.log(`seconds played: ${times.length}, final status ${status}`);
console.log(`ms per second of play: p50 ${pct(0.5)} p95 ${pct(0.95)} max ${pct(1)}`);
console.log(
  `lua heap ${(vm.memoryUsed() / 1024).toFixed(0)} KiB, checkpoint ${(checkpoint.length / 1024).toFixed(1)} KiB`,
);
console.log('facts:', vm.call('sv_facts').replace(/\n/g, ' '));

if (checkpoint) {
  const restored = await LuaVm.create(options);
  const t0 = performance.now();
  restored.call('sv_load', `${bundle.entry}|${checkpoint}`);
  const loadMs = performance.now() - t0;
  for (const [input, expected] of replay) {
    const got = restored.call('sv_steps', input);
    if (got !== expected) throw new Error(`restore diverged: ${got} != ${expected}`);
  }
  console.log(
    `checkpoint restore ${loadMs.toFixed(2)} ms; ${replay.length} replayed seconds match`,
  );
}
