// Prints one status line per second of scripted play from the Wasm verifier.
// tools/trace.py produces the same lines from native Lua; diff them for parity.
// Usage: node tools/trace.mjs <bundle.json> <seed> <maxSeconds> [random|circle]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuaVm } from '../src/vm/host.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [bundlePath, seedArg, secondsArg, mode = 'random'] = process.argv.slice(2);
const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
const vm = await LuaVm.create({
  wasm: new WebAssembly.Module(readFileSync(join(root, 'src', 'vm', 'lua51.wasm'))),
  driver: readFileSync(join(root, 'src', 'vm', 'driver.lua'), 'utf8'),
  modules: bundle.modules,
  limits: { memory: 32 << 20, instructions: 1e9 },
});

// Same generator as tools/trace.py: Park-Miller, a 20-tick run per draw.
let state = Number(seedArg);
const lines = [vm.call('sv_start', `${bundle.entry}|${seedArg}`)];
for (let s = 0; s < Number(secondsArg); s++) {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    state = (state * 48271) % 2147483647;
    runs.push(`20:${mode === 'circle' && i < 2 ? 5 : state % 16}`);
  }
  const status = vm.call('sv_steps', runs.join(','));
  lines.push(status);
  if (status.split('|')[1] === '1') break;
}
lines.push(vm.call('sv_facts').replace(/\n/g, ' '));
console.log(lines.join('\n'));
