# ActiveDev Server

Backend server for the ActiveDev Chrome extension. Handles GitHub App OAuth so client secrets are never exposed.

The server uses **HMAC-signed state tokens** (no database needed) — the entire OAuth state is encoded and signed with the client secret, making it safe for serverless platforms like Vercel.

## Deploy to Vercel

### 1. Create a GitHub App

1. Go to [GitHub Developer Settings](https://github.com/settings/developers) → **GitHub Apps** → **New GitHub App**
2. Fill in:
   - **App name**: `ActiveDev`
   - **Homepage URL**: `https://github.com`
   - **Callback URL**: `https://your-project.vercel.app/api/auth/callback`
   - **Expire user authorization tokens**: Leave unchecked
   - **Request user authorization (OAuth) during installation**: Checked
3. **Permissions**: Pull requests (Read-only), Checks (Read-only), Metadata (Read-only)
4. Click **Create GitHub App**
5. Copy the **Client ID** and generate a **Client Secret**

### 2. Deploy

1. Push the project to a GitHub repo
2. Go to [vercel.com](https://vercel.com) → **Add New Project** → Import your repo
3. In the Vercel dashboard, add these **Environment Variables**:
   - `GITHUB_CLIENT_ID` — from your GitHub App
   - `GITHUB_CLIENT_SECRET` — from your GitHub App
   - `PUBLIC_URL` — `https://your-project.vercel.app`
4. Deploy — Vercel detects `vercel.json` and `api/index.js` automatically

Your server is live at `https://your-project.vercel.app`.

### 3. Connect the Extension

1. Install the extension in Chrome (Load unpacked)
2. Open extension **Settings**
3. Enter `https://your-project.vercel.app` as the Server URL
4. Click **Login with GitHub**

### Local Development

```bash
# From project root
npm install
PUBLIC_URL=http://localhost:3000 GITHUB_CLIENT_ID=xxx GITHUB_CLIENT_SECRET=xxx npm start
```

The server uses stateless HMAC-signed tokens — no Redis or database required.
