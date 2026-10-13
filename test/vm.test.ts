import { describe, expect, it } from 'vitest';
import bundle from '../games/ahsteroids/rulesets/45629a5a0139f70a.json';
import driver from '../src/vm/driver.lua';
import { LuaVm, VmError } from '../src/vm/host.js';
import wasm from '../src/vm/lua51.wasm';

const limits = { memory: 32 << 20, instructions: 50_000_000 };

describe('verifier VM in workerd', () => {
  it('runs the packed Ah!Steroids ruleset deterministically', async () => {
    const a = await LuaVm.create({ wasm, driver, modules: bundle.modules, limits });
    const b = await LuaVm.create({ wasm, driver, modules: bundle.modules, limits });
    a.call('sv_start', 'game.ranked|42');
    b.call('sv_start', 'game.ranked|42');
    for (let i = 0; i < 10; i++) {
      expect(a.call('sv_steps', '30:1,30:6')).toBe(b.call('sv_steps', '30:1,30:6'));
    }
  });

  it('does not expose host or platform-dependent functions to games', async () => {
    const probe = `return { probe = function()
      return tostring(os) .. tostring(io) .. tostring(math.sin) .. tostring(loadstring) .. tostring(string.dump)
    end }`;
    const vm = await LuaVm.create({ wasm, driver, modules: { ...bundle.modules, probe }, limits });
    expect(vm.call('require', 'probe')).toBe('');
  });

  it('stops runaway code at the instruction budget and refuses further calls', async () => {
    const spin = 'function sv_spin() while true do end end';
    const vm = await LuaVm.create({ wasm, driver, modules: { ...bundle.modules, spin }, limits });
    vm.call('require', 'spin');
    expect(() => vm.call('sv_spin')).toThrow(/instruction budget/);
    expect(() => vm.call('sv_status')).toThrow(VmError);
  });

  it('caps Lua memory', async () => {
    const hog = 'function sv_hog() local t = {} for i = 1, 1e8 do t[i] = i end end';
    const vm = await LuaVm.create({
      wasm,
      driver,
      modules: { ...bundle.modules, hog },
      limits: { ...limits, memory: 1 << 20 },
    });
    vm.call('require', 'hog');
    expect(() => vm.call('sv_hog')).toThrow(/memory/);
  });

  it('rejects precompiled bytecode', async () => {
    await expect(
      LuaVm.create({ wasm, driver, modules: { evil: '\x1bLua' }, limits }),
    ).rejects.toThrow(/binary chunks/);
  });
});
