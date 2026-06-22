import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';

const router = Router();

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

function createStateToken(extensionId, chromeRedirectUri) {
  const payload = {
    ext: extensionId,
    uri: chromeRedirectUri,
    ts: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', config.github.clientSecret)
    .update(encoded)
    .digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyStateToken(state) {
  const dot = state.lastIndexOf('.');
  if (dot === -1) throw new Error('Invalid state format');

  const encoded = state.slice(0, dot);
  const sig = state.slice(dot + 1);

  const expectedSig = crypto
    .createHmac('sha256', config.github.clientSecret)
    .update(encoded)
    .digest('base64url');

  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) {
    throw new Error('Invalid state signature');
  }

  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());

  if (Date.now() - payload.ts > config.stateTtlMs) {
    throw new Error('State token expired');
  }

  return {
    extensionId: payload.ext,
    chromeRedirectUri: payload.uri,
  };
}

/**
 * GET /api/auth/start
 *
 * Entry point called by chrome.identity.launchWebAuthFlow.
 * Creates a self-contained HMAC-signed state token and redirects to GitHub.
 *
 * Query parameters:
 *   - extension_id (required): Chrome extension ID
 *   - redirect_uri  (optional): Chrome's redirect URL (chromiumapp.org)
 */
router.get('/start', (req, res) => {
  const { extension_id, redirect_uri: chromeRedirectUri } = req.query;

  if (!extension_id || !/^[a-z]{32}$/.test(extension_id)) {
    return res.status(400).send('Invalid extension_id. Must be a 32-char lowercase hex string.');
  }

  const state = createStateToken(
    extension_id,
    chromeRedirectUri || `https://${extension_id}.chromiumapp.org/`
  );

  const callbackUrl = `${config.publicUrl}/api/auth/callback`;
  const githubAuthUrl = new URL(GITHUB_AUTHORIZE_URL);
  githubAuthUrl.searchParams.set('client_id', config.github.clientId);
  githubAuthUrl.searchParams.set('redirect_uri', callbackUrl);
  githubAuthUrl.searchParams.set('state', state);
  githubAuthUrl.searchParams.set('scope', 'repo read:user');
  githubAuthUrl.searchParams.set('response_type', 'code');

  res.redirect(302, githubAuthUrl.toString());
});

/**
 * GET /api/auth/callback
 *
 * GitHub redirects here after user authorizes. Exchanges code for
 * access token, then redirects back to the extension via chromiumapp.org.
 *
 * Query parameters:
 *   - code  (required): Authorization code from GitHub
 *   - state (required): State token from /start
 */
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  if (!code) return res.status(400).send('Missing authorization code.');
  if (!state) return res.status(400).send('Missing state parameter.');

  let stateData;
  try {
    stateData = verifyStateToken(state);
  } catch (err) {
    return res.status(400).send(`Invalid or expired state: ${err.message}`);
  }

  try {
    const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        client_id: config.github.clientId,
        client_secret: config.github.clientSecret,
        code,
        redirect_uri: `${config.publicUrl}/api/auth/callback`,
      }),
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      console.error('GitHub token exchange error:', tokenData.error_description || tokenData.error);
      return res.status(400).send(`OAuth error: ${tokenData.error_description || tokenData.error}`);
    }

    if (!tokenData.access_token) {
      return res.status(500).send('No access token received from GitHub.');
    }

    const redirectTarget = new URL(stateData.chromeRedirectUri);
    redirectTarget.searchParams.set('access_token', tokenData.access_token);

    if (tokenData.expires_in) {
      redirectTarget.searchParams.set('expires_in', String(tokenData.expires_in));
    }

    res.redirect(302, redirectTarget.toString());
  } catch (error) {
    console.error('Token exchange failed:', error);
    res.status(500).send('Token exchange failed. Please try again.');
  }
});

/**
 * GET /api/health
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    app: config.github.appName,
  });
});

export { router as authRouter };
