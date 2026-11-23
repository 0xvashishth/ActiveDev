import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.GITHUB_CLIENT_ID = 'id';
process.env.GITHUB_CLIENT_SECRET = 'secret';

test('re-exports the Express app used by Vercel (default export of server/app.js)', async () => {
  const [{ default: fromApi }, { default: fromServer }] = await Promise.all([
    import('../api/index.js'),
    import('../server/app.js'),
  ]);
  assert.equal(fromApi, fromServer);
  assert.equal(typeof fromApi, 'function'); // an Express app is callable
});
