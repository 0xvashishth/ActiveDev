# ActiveDev — GitHub Review Reminder

A Chrome extension that ensures you never miss a GitHub review request. Get notified when you're added as a reviewer or when someone reviews your PR.

## Architecture

```
┌─────────────────┐     OAuth flow via      ┌──────────────┐     GitHub OAuth      ┌─────────┐
│  Chrome Extension│  ───────────────────►   │  Your Server  │  ───────────────────►  │  GitHub  │
│  (no secrets)    │  ◄───────────────────   │ (has secrets) │  ◄───────────────────  │          │
└─────────────────┘    chrome.identity.       └──────────────┘                        └─────────┘
                       launchWebAuthFlow
```

- **Extension**: Stores no GitHub credentials. Only the server URL and the resulting access token.
- **Server**: Holds the GitHub OAuth App Client ID and Client Secret. Handles the OAuth code exchange.
- **GitHub OAuth App**: Granular read-only permissions (Pull requests, Checks, Metadata).

## Features

- **Review Request Notifications** — Chrome notification when added as a reviewer
- **Review Received Notifications** — Notified when someone reviews your PRs
- **Review Requests Dashboard** — PRs where you're a requested reviewer
- **My PRs Dashboard** — Your open PRs with review status + CI status
- **Polling every 3 minutes** — Automatic background checks

## Setup

### 1. Create a GitHub OAuth App

1. Go to [GitHub Developer Settings](https://github.com/settings/developers) → **OAuth Apps** → **New OAuth App**
2. Fill in:
   - **Application name**: `ActiveDev`
   - **Homepage URL**: `https://github.com`
   - **Authorization callback URL**: `https://your-project.vercel.app/api/auth/callback`
3. Click **Register application**
4. Copy the **Client ID** and generate a **Client Secret**

### 2. Deploy the Server to Vercel

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → **Add New Project** → Import your repo
3. Add these **Environment Variables** in Vercel dashboard:
   - `GITHUB_CLIENT_ID` — from your GitHub OAuth App
   - `GITHUB_CLIENT_SECRET` — from your GitHub OAuth App
   - `PUBLIC_URL` — `https://your-project.vercel.app`
4. Deploy — done.

The server is stateless (HMAC-signed state tokens), so no database is needed.

### 3. Install the Extension

1. Open Chrome → `chrome://extensions` → Enable **Developer mode**
2. Click **Load unpacked** → select this folder
3. Click the extension icon → **Settings**
4. Enter `https://your-project.vercel.app` → **Login with GitHub**

## Project Structure

```
ActiveDev/
├── api/index.js             # Vercel serverless entry point
├── vercel.json              # Vercel deployment config
├── package.json             # Root dependencies (for Vercel build)
├── manifest.json            # Extension manifest (MV3)
├── background.js            # Service worker: polling & notifications
├── lib/
│   ├── constants.js         # Shared constants
│   ├── auth.js              # Server-based GitHub OAuth
│   └── github-api.js        # GitHub API wrapper
├── popup/
│   ├── popup.html / .js / .css
├── options/
│   ├── options.html / .js / .css
├── server/
│   ├── app.js               # Express app (no listen, reusable)
│   ├── index.js             # Express server (local dev with listen)
│   ├── config.js            # Server configuration
│   ├── routes/auth.js       # OAuth routes (stateless HMAC tokens)
│   ├── .env.example
│   └── README.md            # Vercel deployment guide
├── icons/
│   └── icon128.png
└── README.md
```

## Security

- OAuth access token is stored in `chrome.storage.local` (not synced across devices)
- Client ID and Client Secret are stored locally
- CSRF protection via OAuth `state` parameter
- Token validation on each background check
- Automatic logout on token expiration

## Permissions

| Permission | Reason |
|-----------|--------|
| `identity` | GitHub OAuth via `chrome.identity.launchWebAuthFlow` |
| `alarms` | Polling every 3 minutes |
| `notifications` | Chrome notifications for review events |
| `storage` | Store access token and PR data locally |
| `https://api.github.com/*` | GitHub API requests |
| `https://github.com/*` | GitHub OAuth authorization |
