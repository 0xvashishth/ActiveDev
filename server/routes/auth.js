import { Router } from 'express';
import crypto from 'node:crypto';
import { config } from '../config.js';

const router = Router();

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

// `read:org` lets the extension list the organizations (and teams) the user
// belongs to, so review requests coming from org repos / teams are visible.
const OAUTH_SCOPES = 'repo read:user read:org';

const EXTENSION_ID_RE = /^[a-p]{32}$/; // Chrome extension IDs use the letters a-p

/**
 * The only redirect target we ever send a token to is the calling extension's
 * own chromiumapp.org URL. Anything else would let a crafted /start link
 * exfiltrate the user's GitHub token to an arbitrary site.
 */
function resolveChromeRedirectUri(extensionId, requested) {
  const expectedOrigin = `https://${extensionId}.chromiumapp.org`;
  if (!requested) return `${expectedOrigin}/`;

  let url;
  try {
    url = new URL(requested);
  } catch {
    return null;
  }
  if (url.origin !== expectedOrigin || url.username || url.password) return null;
  url.hash = '';
  return url.toString();
}

function isExtensionAllowed(extensionId) {
  return config.allowedExtensionIds.length === 0 || config.allowedExtensionIds.includes(extensionId);
}

/** Sends the result back to the extension in the URL fragment (never sent to any server). */
function redirectToExtension(res, chromeRedirectUri, params) {
  const target = new URL(chromeRedirectUri);
  target.hash = new URLSearchParams(params).toString();
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  res.redirect(302, target.toString());
}

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

  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid state signature');
  }

  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString());

  if (typeof payload.ts !== 'number' || Date.now() - payload.ts > config.stateTtlMs) {
    throw new Error('State token expired');
  }

  // Defense in depth: the signed URI must still belong to the signed extension.
  if (resolveChromeRedirectUri(payload.ext, payload.uri) !== payload.uri) {
    throw new Error('Invalid redirect target');
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
 *   - redirect_uri  (optional): Chrome's redirect URL; must be
 *                               https://<extension_id>.chromiumapp.org/...
 */
router.get('/start', (req, res) => {
  const { extension_id, redirect_uri: requestedRedirectUri } = req.query;

  if (typeof extension_id !== 'string' || !EXTENSION_ID_RE.test(extension_id)) {
    return res.status(400).send('Invalid extension_id. Must be a 32-character Chrome extension ID.');
  }
  if (!isExtensionAllowed(extension_id)) {
    return res.status(403).send('This extension is not allowed to use this server.');
  }
  if (requestedRedirectUri !== undefined && typeof requestedRedirectUri !== 'string') {
    return res.status(400).send('Invalid redirect_uri.');
  }

  const chromeRedirectUri = resolveChromeRedirectUri(extension_id, requestedRedirectUri);
  if (!chromeRedirectUri) {
    return res.status(400).send('Invalid redirect_uri. It must point to the extension\'s chromiumapp.org URL.');
  }

  const state = createStateToken(extension_id, chromeRedirectUri);

  const callbackUrl = `${config.publicUrl}/api/auth/callback`;
  const githubAuthUrl = new URL(GITHUB_AUTHORIZE_URL);
  githubAuthUrl.searchParams.set('client_id', config.github.clientId);
  githubAuthUrl.searchParams.set('redirect_uri', callbackUrl);
  githubAuthUrl.searchParams.set('state', state);
  githubAuthUrl.searchParams.set('scope', OAUTH_SCOPES);

  res.set('Cache-Control', 'no-store');
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
  const { code, state, error, error_description: errorDescription } = req.query;

  if (typeof state !== 'string' || !state) return res.status(400).send('Missing state parameter.');

  let stateData;
  try {
    stateData = verifyStateToken(state);
  } catch (err) {
    return res.status(400).send(`Invalid or expired state: ${err.message}`);
  }

  // e.g. the user clicked "Cancel" on GitHub: hand the error back to the
  // extension so the auth window closes with a useful message.
  if (error) {
    return redirectToExtension(res, stateData.chromeRedirectUri, {
      error: String(error),
      ...(errorDescription ? { error_description: String(errorDescription) } : {}),
    });
  }
  if (typeof code !== 'string' || !code) return res.status(400).send('Missing authorization code.');

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

    const tokenData = await tokenResponse.json().catch(() => ({}));

    if (tokenData.error) {
      console.error('GitHub token exchange error:', tokenData.error_description || tokenData.error);
      return redirectToExtension(res, stateData.chromeRedirectUri, {
        error: String(tokenData.error),
        error_description: String(tokenData.error_description || tokenData.error),
      });
    }

    if (!tokenData.access_token) {
      return res.status(500).send('No access token received from GitHub.');
    }

    redirectToExtension(res, stateData.chromeRedirectUri, {
      access_token: tokenData.access_token,
      ...(tokenData.scope !== undefined ? { scope: tokenData.scope } : {}),
      ...(tokenData.expires_in ? { expires_in: String(tokenData.expires_in) } : {}),
    });
  } catch (error) {
    console.error('Token exchange failed:', error);
    res.status(500).send('Token exchange failed. Please try again.');
  }
});

/**
 * GET /api/auth/app
 *
 * Public OAuth app info. The extension uses the client ID to link users to
 * https://github.com/settings/connections/applications/<client_id>, where they
 * can grant (or request) access for organizations that restrict OAuth apps.
 */
router.get('/app', (req, res) => {
  res.json({ client_id: config.github.clientId || null, scopes: OAUTH_SCOPES.split(' ') });
});

/**
 * GET /api/auth/health
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    app: 'active-dev',
  });
});

export { router as authRouter, resolveChromeRedirectUri, createStateToken, verifyStateToken };
