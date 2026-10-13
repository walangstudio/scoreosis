// Copies the shared Scoreosis Lua client library into a Defold game checkout.
// Usage: node tools/sync-client.mjs <game-checkout>
import { cpSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!target) throw new Error('usage: sync-client.mjs <game-checkout>');
for (const file of readdirSync(join(root, 'scoreosis')).filter((f) => f.endsWith('.lua'))) {
  cpSync(join(root, 'scoreosis', file), join(target, 'scoreosis', file));
}
console.log(`synced scoreosis/ into ${target}`);
