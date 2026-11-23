import { test } from 'node:test';
import assert from 'node:assert/strict';

// server/config.js reads process.env once at import time; set these before
// anything (including this file's own `app.js` import below) pulls it in.
process.env.GITHUB_CLIENT_ID = 'id';
process.env.GITHUB_CLIENT_SECRET = 'secret';
process.env.PORT = '0'; // ask the OS for a free ephemeral port
process.env.PUBLIC_URL = 'http://localhost:0';

// `server/index.js` imports the default export of `./app.js` and never
// exposes the http.Server that `.listen()` returns, so without this we'd
// have no handle to close it (and a real open port would keep this test's
// subprocess alive forever). Since both imports resolve to the same
// canonical (un-queried) module instance, patching `.listen` here before
// importing server/index.js intercepts the real call it makes.
const { default: app } = await import('../server/app.js');
let server;
const realListen = app.listen.bind(app);
app.listen = (...args) => {
  server = realListen(...args);
  server.unref();
  return server;
};

test('starts listening and logs the port and public URL', async (t) => {
  const logs = [];
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));

  await import('../server/index.js');
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(server, 'app.listen was called');
  assert.match(logs.join('\n'), /running on port \d+/);
  assert.match(logs.join('\n'), /Public URL: http:\/\/localhost:0/);

  server.close();
});
