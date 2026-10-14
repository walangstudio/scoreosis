// Builds src/vm/lua51.wasm from pinned upstream Lua 5.1.5 plus vm/sv.c.
// Requires `python -m pip install ziglang==0.16.0`.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LUA_URL = 'https://www.lua.org/ftp/lua-5.1.5.tar.gz';
const LUA_SHA256 = '2640fc56a795f29d28ef15e13c34a47e223960b0240e8cb0a82d9b0738695333';
const ZIG_VERSION = '0.16.0';
const CORE = [
  'lapi',
  'lcode',
  'ldebug',
  'ldo',
  'ldump',
  'lfunc',
  'lgc',
  'llex',
  'lmem',
  'lobject',
  'lopcodes',
  'lparser',
  'lstate',
  'lstring',
  'ltable',
  'ltm',
  'lundump',
  'lvm',
  'lzio',
  'lauxlib',
  'lbaselib',
  'lmathlib',
  'lstrlib',
  'ltablib',
];
const EXPORTS = [
  'sv_malloc',
  'sv_free',
  'sv_open',
  'sv_module',
  'sv_call',
  'sv_install_require',
  'sv_result_ptr',
  'sv_result_len',
  'sv_mem_used',
  'sv_soft_left',
];

const cache = join(root, 'vm', '.cache');
const tarball = join(cache, 'lua-5.1.5.tar.gz');
mkdirSync(cache, { recursive: true });
if (!existsSync(tarball)) {
  const res = await fetch(LUA_URL);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
}
const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex');
if (sha !== LUA_SHA256) throw new Error(`lua tarball sha256 mismatch: ${sha}`);

const work = join(cache, 'build');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
execFileSync('tar', ['-xzf', 'lua-5.1.5.tar.gz', '-C', 'build'], { cwd: cache });
const src = join(work, 'lua-5.1.5', 'src');

// Errors unwind through the host instead of setjmp/longjmp, which Wasm lacks without EH.
const confPath = join(src, 'luaconf.h');
const upstreamThrow =
  '#define LUAI_THROW(L,c)\tlongjmp((c)->b, 1)\n#define LUAI_TRY(L,c,a)\tif (setjmp((c)->b) == 0) { a }\n#define luai_jmpbuf\tjmp_buf';
const conf = readFileSync(confPath, 'utf8');
if (!conf.includes(upstreamThrow)) throw new Error('luaconf.h throw block not found');
writeFileSync(
  confPath,
  conf.replace(
    upstreamThrow,
    'struct lua_State;\nvoid sv_throw(struct lua_State *L);\n#define LUAI_THROW(L,c)\tsv_throw(L)\n#define LUAI_TRY(L,c,a)\t{ a }\n#define luai_jmpbuf\tint',
  ),
);
const ldoPath = join(src, 'ldo.c');
writeFileSync(ldoPath, readFileSync(ldoPath, 'utf8').replace('#include <setjmp.h>\n', ''));

const zig = execFileSync('python', ['-m', 'ziglang', 'version'], { encoding: 'utf8' }).trim();
if (zig !== ZIG_VERSION) throw new Error(`zig ${ZIG_VERSION} required, found ${zig}`);

const out = join(root, 'src', 'vm', 'lua51.wasm');
mkdirSync(dirname(out), { recursive: true });
execFileSync(
  'python',
  [
    '-m',
    'ziglang',
    'cc',
    '-target',
    'wasm32-wasi',
    '-mexec-model=reactor',
    '-O2',
    '-ffp-contract=off',
    '-fno-fast-math',
    `-I${src}`,
    ...CORE.map((f) => join(src, `${f}.c`)),
    join(root, 'vm', 'sv.c'),
    '-Wl,--no-entry',
    // Start small and grow on demand: every loaded verifier holds its memory, and a
    // Worker isolate's objects share one 128 MB limit. Zig's default 16 MiB stack made
    // each VM 17 MiB.
    '-Wl,-z,stack-size=1048576',
    '-Wl,--initial-memory=2097152',
    '-Wl,--max-memory=67108864',
    '-Wl,--strip-all',
    ...EXPORTS.map((e) => `-Wl,--export=${e}`),
    '-o',
    out,
  ],
  { stdio: 'inherit' },
);
const wasm = readFileSync(out);
const mod = new WebAssembly.Module(wasm);
console.log(`built ${out} (${wasm.length} bytes)`);
console.log(
  'imports:',
  WebAssembly.Module.imports(mod)
    .map((i) => `${i.module}.${i.name}`)
    .join(', '),
);
