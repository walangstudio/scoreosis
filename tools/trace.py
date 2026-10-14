"""Native-Lua twin of tools/trace.mjs. Runs the same bundle and inputs under
LuaJIT or PUC Lua 5.1 (via lupa) so traces can be diffed against the Wasm VM.

Usage: python tools/trace.py <bundle.json> <seed> <maxSeconds> [luajit|lua51] [random|circle]
"""

import importlib
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
bundle_path, seed, seconds = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
flavor = sys.argv[4] if len(sys.argv) > 4 else "luajit"
mode = sys.argv[5] if len(sys.argv) > 5 else "random"
lupa = importlib.import_module({"luajit": "lupa.luajit21", "lua51": "lupa.lua51"}[flavor])
bundle = json.loads(Path(bundle_path).read_text(encoding="utf-8"))
modules = dict(bundle["modules"])
modules["scoreosis.driver"] = (root / "src" / "vm" / "driver.lua").read_text(encoding="utf-8")

lua = lupa.LuaRuntime(unpack_returned_tuples=True)
lua.execute("function sv_soft_exhausted() return false end")
preload = lua.eval("package.preload")
for name, source in modules.items():
    preload[name] = lua.execute(f"return function(...) {source}\nend")
lua.execute('require "scoreosis.driver"')
g = lua.globals()

state = seed
lines = [g.sv_start(f"{bundle['entry']}|{seed}")]
for _ in range(seconds):
    runs = []
    for i in range(3):
        state = (state * 48271) % 2147483647
        runs.append(f"20:{5 if mode == 'circle' and i < 2 else state % 16}")
    status = g.sv_steps(",".join(runs))
    lines.append(status)
    if status.split("|")[1] == "1":
        break
lines.append(g.sv_facts().replace("\n", " "))
print("\n".join(lines))
