import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const OTHER = 'pppppppppppppppppppppppppppppppp'.slice(0, 32); // valid format (a-p), just not allow-listed

// config.js reads process.env once at import time, so the allowlist must be
// set before anything in this process first imports it.
process.env.GITHUB_CLIENT_ID = 'client-123';
process.env.GITHUB_CLIENT_SECRET = 'secret-xyz';
process.env.PUBLIC_URL = 'https://server.example';
process.env.ALLOWED_EXTENSION_IDS = `${EXT}, ${EXT} `; // duplicates/whitespace should be harmless

let server;
let base;

before(async () => {
  const { default: app } = await import('../server/app.js');
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test('an allowed extension can start the OAuth flow', async () => {
  const res = await fetch(`${base}/api/auth/start?extension_id=${EXT}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
});

test('a non-allowed extension is rejected before any redirect to GitHub', async () => {
  const res = await fetch(`${base}/api/auth/start?extension_id=${OTHER}`, { redirect: 'manual' });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /not allowed to use this server/);
});
