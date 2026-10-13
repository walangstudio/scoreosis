// Packs a game's ranked Lua modules into games/<id>/rulesets/<ruleset>.json and
// regenerates games/rulesets.generated.ts. Usage:
//   node tools/pack-game.mjs <game-id> [--allow-dirty]
// The game's source checkout and entry module come from games/<id>/game.json.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuaVm } from '../src/vm/host.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [gameId, ...flags] = process.argv.slice(2);
if (!gameId) throw new Error('usage: pack-game.mjs <game-id> [--allow-dirty]');
const allowDirty = flags.includes('--allow-dirty');
const game = JSON.parse(readFileSync(join(root, 'games', gameId, 'game.json'), 'utf8'));
const source = process.env[`SCOREOSIS_SRC_${gameId.toUpperCase()}`] ?? game.source;

const FORBIDDEN = [
  [
    /\bmath\.(random|randomseed|sin|cos|tan|asin|acos|atan2?|exp|log|log10|pow|sinh|cosh|tanh)\b/,
    'platform-dependent math; use scoreosis.detmath',
  ],
  [/\b(os|io|debug|package)\./, 'host library access'],
  [/\b(loadstring|dofile|loadfile|setfenv|getfenv|collectgarbage)\b/, 'unsafe builtin'],
  [/\^/, 'the ^ operator calls pow(); multiply instead'],
  [/\b(pcall|xpcall)\b|\bcoroutine\./, 'the verifier cannot catch errors or run coroutines'],
  [
    /\btable\.sort\b/,
    'table.sort orders ties differently across Lua builds; sort with a total order by hand',
  ],
];

const LONG_OPEN = /\[(=*)\[/y;

/**
 * One pass over Lua source: drops comments (keeping line breaks) and replaces
 * each string literal with a "S<n>" placeholder, so the lint only sees code.
 */
function scan(src) {
  const strings = [];
  const breaks = (text) => text.replace(/[^\n]/g, '');
  const longEnd = (from, level) => {
    const close = `]${level}]`;
    const at = src.indexOf(close, from);
    return at < 0 ? [src.length, src.length] : [at, at + close.length];
  };
  let code = '';
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('--', i)) {
      LONG_OPEN.lastIndex = i + 2;
      const long = LONG_OPEN.exec(src);
      const end = long ? longEnd(LONG_OPEN.lastIndex, long[1])[1] : src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      code += breaks(src.slice(i, stop));
      i = stop;
      continue;
    }
    LONG_OPEN.lastIndex = i;
    const long = src[i] === '[' ? LONG_OPEN.exec(src) : null;
    if (long) {
      const [contentEnd, end] = longEnd(LONG_OPEN.lastIndex, long[1]);
      strings.push(src.slice(LONG_OPEN.lastIndex, contentEnd));
      code += `"S${strings.length - 1}"${breaks(src.slice(i, end))}`;
      i = end;
      continue;
    }
    const quote = src[i];
    if (quote === '"' || quote === "'") {
      let j = i + 1;
      let value = '';
      while (j < src.length && src[j] !== quote && src[j] !== '\n') {
        value += src[j] === '\\' ? (src[j + 1] ?? '') : src[j];
        j += src[j] === '\\' ? 2 : 1;
      }
      strings.push(value);
      code += `"S${strings.length - 1}"`;
      i = j + 1;
      continue;
    }
    code += src[i];
    i++;
  }
  return { code, strings };
}

function modulePath(name) {
  if (name.startsWith('scoreosis.')) return `${join(root, ...name.split('.'))}.lua`;
  return `${join(source, ...name.split('.'))}.lua`;
}

const modules = {};
const problems = [];
const queue = [game.entry];
while (queue.length > 0) {
  const name = queue.shift();
  if (modules[name] !== undefined) continue;
  const path = modulePath(name);
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  modules[name] = text;
  const { code, strings } = scan(text);
  if (!name.startsWith('scoreosis.')) {
    code.split('\n').forEach((line, i) => {
      for (const [pattern, why] of FORBIDDEN) {
        if (pattern.test(line)) problems.push(`${name}:${i + 1}: ${why}: ${line.trim()}`);
      }
    });
  }
  const required = [...code.matchAll(/\brequire\s*\(?\s*"S(\d+)"/g)].map(
    (m) => strings[Number(m[1])],
  );
  if (
    (code.match(/\brequire\b/g) ?? []).length !== required.length ||
    required.some((r) => !/^[\w.]+$/.test(r ?? ''))
  ) {
    problems.push(`${name}: only literal require "module" calls are supported`);
  }
  queue.push(...required);
}
modules['scoreosis.codec'] ??= readFileSync(join(root, 'scoreosis', 'codec.lua'), 'utf8');

for (const name of Object.keys(modules).filter((n) => n.startsWith('scoreosis.'))) {
  const vendored = `${join(source, ...name.split('.'))}.lua`;
  if (!existsSync(vendored)) {
    problems.push(`${vendored} is missing; run node tools/sync-client.mjs ${source}`);
  } else if (readFileSync(vendored, 'utf8').replace(/\r\n/g, '\n') !== modules[name]) {
    problems.push(`${vendored} differs from scoreosis/; run node tools/sync-client.mjs ${source}`);
  }
}
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD');
const dirty =
  git(
    'status',
    '--porcelain',
    '--',
    ...Object.keys(modules).map((n) => `${n.split('.').join('/')}.lua`),
  ) !== '';
if (dirty && !allowDirty)
  throw new Error('ranked modules have uncommitted changes; commit them or pass --allow-dirty');

const vm = await LuaVm.create({
  wasm: new WebAssembly.Module(readFileSync(join(root, 'src', 'vm', 'lua51.wasm'))),
  driver: readFileSync(join(root, 'src', 'vm', 'driver.lua'), 'utf8'),
  modules,
  limits: { memory: 64 << 20, instructions: 1e9 },
});
const buttons = Number(vm.call('sv_buttons', game.entry));
if (!Number.isInteger(buttons) || buttons < 1 || buttons > 16)
  throw new Error(`buttons must be 1..16, got ${buttons}`);
const achievements = vm
  .call('sv_catalog', game.entry)
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [id, fact, mode, gte, name, description] = line.split('\t');
    const a = { id, fact, mode, gte: Number(gte), name, description };
    const valid =
      /^[a-z0-9_]{1,40}$/.test(id) &&
      /^[a-z0-9_]{1,40}$/.test(fact) &&
      (mode === 'run' || mode === 'total') &&
      Number.isInteger(a.gte) &&
      a.gte > 0 &&
      name &&
      description;
    if (!valid) throw new Error(`invalid achievement: ${line}`);
    return a;
  });
if (new Set(achievements.map((a) => a.id)).size !== achievements.length)
  throw new Error('duplicate achievement id');
// Smoke run: catches platform-dependent calls the lint missed (the VM removes them).
vm.call('sv_start', `${game.entry}|1`);
vm.call('sv_steps', `600:0`);
const facts = vm
  .call('sv_facts')
  .split('\n')
  .map((l) => l.split('=')[0]);
for (const a of achievements)
  if (!facts.includes(a.fact)) throw new Error(`achievement ${a.id} uses unknown fact ${a.fact}`);
if (!facts.includes('score')) throw new Error('facts must include score');

const names = Object.keys(modules).sort();
const hash = createHash('sha256');
for (const n of names) hash.update(`${n}\0${modules[n]}\0`);
const ruleset = hash.digest('hex').slice(0, 16);
const sorted = Object.fromEntries(names.map((n) => [n, modules[n]]));
const outDir = join(root, 'games', gameId, 'rulesets');
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, `${ruleset}.json`),
  `${JSON.stringify({ game: gameId, ruleset, entry: game.entry, buttons, source: { commit, dirty }, achievements, modules: sorted }, null, 2)}\n`,
);

const lines = [
  '// Generated by tools/pack-game.mjs. Do not edit.',
  "import type { GameConfig, RulesetBundle } from '../src/games.js';",
];
const gameIdents = [];
const rulesetIdents = [];
for (const id of readdirSync(join(root, 'games')).sort()) {
  if (!existsSync(join(root, 'games', id, 'game.json'))) continue;
  const gameIdent = `game_${id}`.replace(/\W/g, '_');
  lines.push(`import ${gameIdent} from './${id}/game.json';`);
  gameIdents.push(gameIdent);
  const dir = join(root, 'games', id, 'rulesets');
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const ident = `${id}_${file.replace('.json', '')}`.replace(/\W/g, '_');
    lines.push(`import ${ident} from './${id}/rulesets/${file}';`);
    rulesetIdents.push(ident);
  }
}
lines.push(
  '',
  `export const games: GameConfig[] = [${gameIdents.join(', ')}];`,
  `export const rulesets: RulesetBundle[] = [${rulesetIdents.join(', ')}];`,
  '',
);
writeFileSync(join(root, 'games', 'rulesets.generated.ts'), lines.join('\n'));
console.log(
  `packed ${gameId} ruleset ${ruleset} from ${commit.slice(0, 8)}${dirty ? ' (dirty)' : ''}: ${names.join(', ')}`,
);
