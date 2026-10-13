"""Runs test/lua/*_test.lua under LuaJIT and PUC Lua 5.1 (via lupa).

Usage: python tools/test-lua.py
"""

import importlib
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
failed = False
for flavor in ("lupa.luajit21", "lupa.lua51"):
    lupa = importlib.import_module(flavor)
    for test in sorted((root / "test" / "lua").glob("*_test.lua")):
        lua = lupa.LuaRuntime(unpack_returned_tuples=True)
        lua.execute(f'package.path = "{root.as_posix()}/?.lua;" .. package.path')
        print(f"{flavor} {test.name}: ", end="", flush=True)
        try:
            lua.execute(test.read_text(encoding="utf-8"))
        except lupa.LuaError as error:
            print(error)
            failed = True
sys.exit(1 if failed else 0)
