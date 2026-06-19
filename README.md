# ActiveDev

A Chrome extension that ensures you never miss a GitHub review request again.

## Features

- **Review Request Notifications** - Get a Chrome notification the moment you're added as a reviewer on any PR
- **Review Received Notifications** - Get notified when someone reviews your open PRs
- **Review Requests Dashboard** - See all PRs where you're a requested reviewer
- **My PRs Dashboard** - See your open PRs with review status and CI status
  - Approved / Changes Requested / Pending Review indicators
  - CI check status (passing, failing, pending)
  - Reviewer tags showing who approved or requested changes
- **Polling every 3 minutes** - Automatically checks for updates in the background

## Setup

### 1. Create a GitHub OAuth App

1. Go to [GitHub Developer Settings](https://github.com/settings/developers) → OAuth Apps → **New OAuth App**
2. Fill in:
   - **Application name**: `ActiveDev`
   - **Homepage URL**: `https://github.com`
   - **Authorization callback URL**: You'll get this from the extension (see step 3)
3. Click **Register application**
4. Copy the **Client ID** and generate a **Client Secret** (save these)

### 2. Install the Extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `github-review-reminder` folder

### 3. Get the Extension ID

1. After loading, note the extension ID from `chrome://extensions` (it's a 32-character string like `abcdefghijklmnopabcdefghijklmnop`)
2. Go to your GitHub OAuth App settings and set the **Authorization callback URL** to:
   `https://<YOUR_EXTENSION_ID>.chromiumapp.org/oauth2`

### 4. Configure the Extension

1. Click the extension icon → **Settings**
2. Or right-click the extension icon → **Options**
3. Paste your **Client ID** and **Client Secret**
4. Click **Save & Authenticate**
5. Authorize the extension in the GitHub popup

## Usage

- Click the extension icon to open the dashboard
- **Review Requests** tab: PRs where you're requested as a reviewer
- **My PRs** tab: Your open PRs with status indicators
- Click any PR to open it in a new tab
- Click **Refresh** to manually trigger a check
- Notifications appear automatically for new review requests and reviews

## Architecture

```
github-review-reminder/
├── manifest.json          # Extension manifest (MV3)
├── background.js          # Service worker: polling, notifications
├── lib/
│   ├── constants.js       # Shared constants
│   ├── auth.js            # GitHub OAuth flow
│   └── github-api.js      # GitHub API wrapper
├── popup/
│   ├── popup.html         # Popup UI
│   ├── popup.js           # Popup logic
│   └── popup.css          # Popup styles
├── options/
│   ├── options.html       # Settings page
│   ├── options.js         # Settings logic
│   └── options.css        # Settings styles
└── icons/
    └── icon128.png        # Extension icon
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
| `identity` | GitHub OAuth authentication flow |
| `alarms` | Periodic background polling (every 3 min) |
| `notifications` | Chrome notifications for review events |
| `storage` | Store OAuth token and PR data locally |
| `https://api.github.com/*` | GitHub API requests |
| `https://github.com/*` | GitHub OAuth authorization |
