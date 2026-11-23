import { test } from 'node:test';
import assert from 'node:assert/strict';

// Deliberately invalid: no GitHub credentials, so validateConfig() should
// reject this before the server ever tries to listen.
delete process.env.GITHUB_CLIENT_ID;
delete process.env.GITHUB_CLIENT_SECRET;
process.env.PORT = '0';

test('logs the problem and exits instead of starting the server', async (t) => {
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  // A real process.exit() would kill this test file's subprocess outright;
  // throwing in its place aborts the module (matching the real effect)
  // while letting us assert what led up to it.
  t.mock.method(process, 'exit', (code) => {
    throw new Error(`process.exit(${code})`);
  });

  await assert.rejects(import('../server/index.js'), /process\.exit\(1\)/);
  assert.match(errors.join('\n'), /Missing required environment variables: GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET/);
});
