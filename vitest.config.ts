import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// Tests run inside workerd with the Worker and its Durable Object from wrangler.jsonc. The relay's
// own log lines show only for failing tests. Dummy APNs secrets switch push availability on; no
// test reaches Apple (pushes go through a fake sender).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: { bindings: { APNS_KEY_P8: 'test-key', APNS_KEY_ID: 'TESTKEYID0', APNS_TEAM_ID: 'TESTTEAM00' } },
    }),
  ],
  test: { silent: 'passed-only' },
});
