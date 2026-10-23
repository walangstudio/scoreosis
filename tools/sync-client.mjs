// Copies the shared Scoreosis client and native TLS extension into a Defold checkout.
// Usage: node tools/sync-client.mjs <game-checkout>
import { cpSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!target) throw new Error('usage: sync-client.mjs <game-checkout>');
for (const file of readdirSync(join(root, 'scoreosis')).filter(
  (f) => f.endsWith('.lua') || f === 'cacert.pem',
)) {
  cpSync(join(root, 'scoreosis', file), join(target, 'scoreosis', file));
}
cpSync(join(root, 'scoreosis_tls'), join(target, 'scoreosis_tls'), { recursive: true });
console.log(`synced scoreosis/ into ${target}`);
