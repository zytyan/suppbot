import { equal, throws } from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

Deno.test('Deno config accepts existing TOML and legacy page flags without connecting to services', () => {
  const config = loadConfig(['--config', 'config/config-template.toml', '-page', '2'], {});
  equal(config.page, 2);
  equal(config.concurrency, 2);
  equal(config.maxAttempts, 3);
  equal(config.linkedMessageTimeoutMs, 300_000);
  equal(config.adminListen, '127.0.0.1:9001');
  const override = loadConfig(['--page=3'], {
    SUPPBOT_CONFIG: 'config/config-template.toml',
    SUPPBOT_ADMIN_LISTEN: '127.0.0.1:9011',
  });
  equal(override.page, 3);
  equal(override.adminListen, '127.0.0.1:9011');
  throws(
    () => loadConfig(['--config', 'config/config-template.toml', '--page', '-1'], {}),
    /Invalid configuration: page/,
  );
});
