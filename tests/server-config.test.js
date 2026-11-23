import { test } from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEYS = ['PORT', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'PUBLIC_URL', 'ALLOWED_EXTENSION_IDS'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function resetEnv(overrides) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
}

let counter = 0;
async function freshConfig(overrides) {
  resetEnv(overrides);
  const mod = await import(`../server/config.js?t=${Date.now()}-${counter++}`);
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  return mod;
}

test('config: sensible defaults with minimal env', async () => {
  const { config } = await freshConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' });
  assert.equal(config.port, 3000);
  assert.equal(config.publicUrl, 'http://localhost:3000');
  assert.deepEqual(config.allowedExtensionIds, []);
});

test('config: custom port, trailing slashes trimmed from PUBLIC_URL, and extension allowlist parsed', async () => {
  const { config } = await freshConfig({
    PORT: '8080',
    GITHUB_CLIENT_ID: 'id',
    GITHUB_CLIENT_SECRET: 'secret',
    PUBLIC_URL: 'https://example.com/',
    ALLOWED_EXTENSION_IDS: ' abc , , def ',
  });
  assert.equal(config.port, 8080);
  assert.equal(config.publicUrl, 'https://example.com');
  assert.deepEqual(config.allowedExtensionIds, ['abc', 'def']);
});

test('validateConfig: reports every missing credential together', async () => {
  const { validateConfig } = await freshConfig({});
  assert.throws(() => validateConfig(), /Missing required environment variables: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET/);
});

test('validateConfig: also reports just one missing credential', async () => {
  const onlyId = await freshConfig({ GITHUB_CLIENT_ID: 'id' });
  assert.throws(() => onlyId.validateConfig(), /Missing required environment variables: GITHUB_CLIENT_SECRET$/);

  const onlySecret = await freshConfig({ GITHUB_CLIENT_SECRET: 'secret' });
  assert.throws(() => onlySecret.validateConfig(), /Missing required environment variables: GITHUB_CLIENT_ID$/);
});

test('validateConfig: passes for https or localhost PUBLIC_URL without warning', async (t) => {
  const warn = t.mock.method(console, 'warn');
  const { validateConfig } = await freshConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', PUBLIC_URL: 'https://example.com' });
  validateConfig();
  assert.equal(warn.mock.callCount(), 0);
});

test('validateConfig: warns when PUBLIC_URL is neither https nor localhost', async (t) => {
  const warn = t.mock.method(console, 'warn');
  const { validateConfig } = await freshConfig({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', PUBLIC_URL: 'http://example.com' });
  validateConfig();
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /should be HTTPS/);
});
