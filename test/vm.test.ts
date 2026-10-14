import { describe, expect, it } from 'vitest';
import driver from '../src/vm/driver.lua';
import { LuaVm, VmError } from '../src/vm/host.js';
import wasm from '../src/vm/lua51.wasm';
import { bundle } from './fixtures.js';

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

  it('fails cleanly on deep C recursion within the 1 MiB stack', async () => {
    const deep = `function sv_meta()
        local t = setmetatable({}, { __index = function(self, k) return self[k + 1] end })
        return t[1]
      end
      function sv_gsub(n)
        local function f(s) if #s < 400 then return (string.gsub(s .. "x", "x$", f)) end return s end
        return f("")
      end`;
    const nested = `return ${'{'.repeat(5000)}${'}'.repeat(5000)}`;
    const vm = await LuaVm.create({ wasm, driver, modules: { ...bundle.modules, deep }, limits });
    vm.call('require', 'deep');
    expect(() => vm.call('sv_meta')).toThrow(/stack overflow/);
    const gsub = await LuaVm.create({ wasm, driver, modules: { ...bundle.modules, deep }, limits });
    gsub.call('require', 'deep');
    expect(() => gsub.call('sv_gsub', '0')).toThrow(/stack overflow/);
    await expect(
      LuaVm.create({ wasm, driver, modules: { ...bundle.modules, nested }, limits }),
    ).rejects.toThrow(/syntax levels/);
    const fresh = await LuaVm.create({ wasm, driver, modules: bundle.modules, limits });
    fresh.call('sv_start', 'game.ranked|42');
    expect(fresh.call('sv_steps', '30:1')).toMatch(/^30\|/);
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
