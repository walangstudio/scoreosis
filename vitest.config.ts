import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          ADMIN_TOKEN: 'test-admin-token-0123456789abcdef0123456789',
          MAX_RUNS_PER_DAY: '1000',
          MAX_RUNS_PER_ADDRESS: '3',
          ADDRESS_KEY: 'test-address-key-0123456789abcdef0123456789',
          ALLOWED_ORIGINS:
            'http://127.0.0.1:8774,http://localhost:8775,http://127.0.0.1:8097,http://localhost:8097',
        },
      },
    })),
  ],
  test: {
    setupFiles: ['./test/setup.ts'],
  },
});
