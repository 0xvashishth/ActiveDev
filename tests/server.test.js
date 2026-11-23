import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.GITHUB_CLIENT_ID = 'client-123';
process.env.GITHUB_CLIENT_SECRET = 'secret-xyz';
process.env.PUBLIC_URL = 'https://server.example';

const EXT = 'abcdefghijklmnopabcdefghijklmnop';
const realFetch = globalThis.fetch;
let server;
let base;
let tokenExchange = () => ({ access_token: 'gho_token', scope: 'repo,read:org,read:user', token_type: 'bearer' });

before(async () => {
  // GitHub's token endpoint is mocked; requests to the local server go through.
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return new Response(JSON.stringify(tokenExchange(JSON.parse(init.body))), { headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  };
  const { default: app } = await import('../server/app.js');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  globalThis.fetch = realFetch;
});

const get = (path) => fetch(`${base}${path}`, { redirect: 'manual' });

async function startAndGetState(query = `extension_id=${EXT}`) {
  const res = await get(`/api/auth/start?${query}`);
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  return location;
}

test('/start redirects to GitHub with read:org scope and signed state', async () => {
  const location = await startAndGetState(`extension_id=${EXT}&redirect_uri=${encodeURIComponent(`https://${EXT}.chromiumapp.org/`)}`);
  assert.equal(location.origin + location.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(location.searchParams.get('client_id'), 'client-123');
  assert.equal(location.searchParams.get('scope'), 'repo read:user read:org');
  assert.equal(location.searchParams.get('redirect_uri'), 'https://server.example/api/auth/callback');
  assert.ok(location.searchParams.get('state').includes('.'));
});

test('/start rejects redirect_uri that does not belong to the extension (token exfiltration)', async () => {
  for (const evil of [
    'https://evil.example/steal',
    `https://${EXT}.chromiumapp.org.evil.example/`,
    `https://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.chromiumapp.org/`,
    `http://${EXT}.chromiumapp.org/`,
    `https://user:pw@${EXT}.chromiumapp.org/`,
    'http://[not-a-valid-host',
  ]) {
    const res = await get(`/api/auth/start?extension_id=${EXT}&redirect_uri=${encodeURIComponent(evil)}`);
    assert.equal(res.status, 400, `should reject ${evil}`);
  }
  assert.equal((await get('/api/auth/start?extension_id=NOT-AN-ID')).status, 400);
  // Express parses repeated query keys (`?redirect_uri=a&redirect_uri=b`) as an array.
  assert.equal((await get(`/api/auth/start?extension_id=${EXT}&redirect_uri=a&redirect_uri=b`)).status, 400);
});

test('createStateToken / verifyStateToken are defended even if misused directly: expiry and tampered redirect URIs', async () => {
  const { createStateToken, verifyStateToken } = await import('../server/routes/auth.js');

  // A forged/miscalled createStateToken with a uri that doesn't belong to the
  // extension must still be rejected on verify (defense in depth).
  const mismatched = createStateToken(EXT, 'https://not-this-extension.example/');
  assert.throws(() => verifyStateToken(mismatched), /Invalid redirect target/);

  // Expiry: reconstruct a state token signed the same way, but already old.
  const payload = { ext: EXT, uri: `https://${EXT}.chromiumapp.org/`, ts: Date.now() - 11 * 60 * 1000 };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const crypto = await import('node:crypto');
  const sig = crypto.createHmac('sha256', process.env.GITHUB_CLIENT_SECRET).update(encoded).digest('base64url');
  assert.throws(() => verifyStateToken(`${encoded}.${sig}`), /State token expired/);
});

test('/callback exchanges the code and returns the token in the URL fragment', async () => {
  const state = (await startAndGetState()).searchParams.get('state');
  let sentBody;
  tokenExchange = (body) => {
    sentBody = body;
    return { access_token: 'gho_token', scope: 'repo,read:org,read:user' };
  };
  const res = await get(`/api/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(res.status, 302);
  const target = new URL(res.headers.get('location'));
  assert.equal(target.origin, `https://${EXT}.chromiumapp.org`);
  assert.equal(target.search, '', 'token must not be in the query string');
  const fragment = new URLSearchParams(target.hash.slice(1));
  assert.equal(fragment.get('access_token'), 'gho_token');
  assert.equal(fragment.get('scope'), 'repo,read:org,read:user');
  assert.equal(sentBody.code, 'abc');
  assert.equal(sentBody.client_secret, 'secret-xyz');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('/callback forwards a user cancellation to the extension', async () => {
  const state = (await startAndGetState()).searchParams.get('state');
  const res = await get(`/api/auth/callback?error=access_denied&error_description=denied&state=${encodeURIComponent(state)}`);
  const fragment = new URLSearchParams(new URL(res.headers.get('location')).hash.slice(1));
  assert.equal(fragment.get('error'), 'access_denied');
  assert.equal(fragment.get('access_token'), null);
});

test('/callback rejects tampered or malformed state', async () => {
  const state = (await startAndGetState()).searchParams.get('state');
  const [payload, sig] = state.split('.');
  const forged = Buffer.from(JSON.stringify({ ext: EXT, uri: 'https://evil.example/', ts: Date.now() })).toString('base64url');
  assert.equal((await get(`/api/auth/callback?code=x&state=${forged}.${sig}`)).status, 400);
  assert.equal((await get(`/api/auth/callback?code=x&state=${payload}.short`)).status, 400);
  assert.equal((await get('/api/auth/callback?code=x')).status, 400);
});

test('/callback surfaces an error from the token exchange response itself (not just ?error=)', async () => {
  const state = (await startAndGetState()).searchParams.get('state');
  tokenExchange = () => ({ error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' });
  const res = await get(`/api/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
  const fragment = new URLSearchParams(new URL(res.headers.get('location')).hash.slice(1));
  assert.equal(fragment.get('error'), 'bad_verification_code');
  assert.equal(fragment.get('error_description'), 'The code passed is incorrect or expired.');
});

test('/callback: a response with neither an error nor a token is a 500', async () => {
  const state = (await startAndGetState()).searchParams.get('state');
  tokenExchange = () => ({});
  const res = await get(`/api/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(res.status, 500);
  assert.match(await res.text(), /No access token/);
});

test('/callback: a network failure talking to GitHub is a 500, not a crash', async () => {
  const state = (await startAndGetState()).searchParams.get('state');
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).startsWith('https://github.com/login/oauth/access_token')) throw new Error('ECONNRESET');
    return previous(input);
  };
  const res = await get(`/api/auth/callback?code=abc&state=${encodeURIComponent(state)}`);
  assert.equal(res.status, 500);
  assert.match(await res.text(), /Token exchange failed/);
  globalThis.fetch = previous;
});

test('/health reports ok', async () => {
  const body = await (await get('/api/auth/health')).json();
  assert.equal(body.status, 'ok');
  assert.equal(body.app, 'active-dev');
  assert.equal(typeof body.timestamp, 'number');
});

test('/app exposes only the public client id', async () => {
  const body = await (await get('/api/auth/app')).json();
  assert.deepEqual(body, { client_id: 'client-123', scopes: ['repo', 'read:user', 'read:org'] });
});

test('GET / describes the API and its auth endpoints', async () => {
  const body = await (await get('/')).json();
  assert.equal(body.name, 'ActiveDev API');
  assert.deepEqual(body.auth_endpoints, {
    start: '/api/auth/start',
    callback: '/api/auth/callback',
    app: '/api/auth/app',
  });
});

test('security headers and CORS are applied (helmet + cors), and unknown routes 404', async () => {
  const res = await get('/');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');

  const withOrigin = await fetch(`${base}/`, { headers: { Origin: 'https://example.com' } });
  assert.equal(withOrigin.headers.get('access-control-allow-origin'), 'https://example.com');

  assert.equal((await get('/nope')).status, 404);
});
