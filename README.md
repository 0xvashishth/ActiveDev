# ActiveDev — GitHub Review Reminder

A Chrome extension that ensures you never miss a GitHub review request — in your own repositories **and in the organizations you belong to**. Get notified when you're added as a reviewer or when someone reviews your PR, and see the state of every PR (reviews, conversations, CI, conflicts) at a glance.

## Architecture

```
┌─────────────────┐     OAuth flow via      ┌──────────────┐     GitHub OAuth      ┌─────────┐
│  Chrome Extension│  ───────────────────►   │  Your Server  │  ───────────────────►  │  GitHub  │
│  (no secrets)    │  ◄───────────────────   │ (has secrets) │  ◄───────────────────  │          │
└─────────────────┘    chrome.identity.       └──────────────┘                        └─────────┘
                       launchWebAuthFlow
```

- **Extension**: Stores no OAuth app secrets — only the resulting access token (in `chrome.storage.local`).
- **Server**: Holds the GitHub OAuth App Client ID and Client Secret. Handles the OAuth code exchange.
- **GitHub OAuth App**: Requests `repo read:user read:org`. OAuth Apps have no read-only scope for private
  repositories, so `repo` is required; the extension itself only ever *reads* from GitHub.

### How data is fetched

Each poll makes a handful of requests, regardless of how many PRs you have:

1. `GET /user` — who you are + which scopes the token has (`X-OAuth-Scopes`).
2. `GET /search/issues` ×2 — `review-requested:<you>` (includes requests to **teams you're on**) and `author:<you>`,
   across every repository and organization the token can see.
3. `POST /graphql` — one batched query (20 PRs per request) for reviews, review threads, requested reviewers,
   CI rollup, merge conflicts, labels and size.
4. Every 30 min (or on demand): your organizations and whether each one blocks the app (see below).

## Features

- **Review Request Notifications** — when you're added as a reviewer, directly or via a team, and when a re-review is requested
- **Review Received Notifications** — when someone approves, requests changes, or comments on your PRs
- **Review Requests dashboard**, per PR:
  - requested **from you** or **via which team**
  - **already reviewed by** others (✓ approved / ✗ changes requested / 💬 commented)
  - **re-review requested**, **new commits since your review**, **your review draft isn't submitted**
  - **conversations**: unresolved vs. resolved threads, and how many of *your* threads are still open
- **My PRs dashboard**, per PR: review decision, each reviewer's verdict, who you're still waiting on,
  unresolved conversations and how many are **awaiting your reply**
- CI status, merge conflicts, draft state, size (+/−), labels, and a quick filter box
- **Organization access diagnostics** — detects orgs that hide PRs because of OAuth App access restrictions
  or SAML SSO, and links you straight to the page that fixes it
- **Notes tab: daily todos & notes** (see below)
- **Focus monitor (opt-in)**: nudges you to finish pending reviews when you've been on YouTube & co. for too long,
  plus a Focus tab that analyses where your time went (see below)
- **Stats tab**: how many PRs you've reviewed and merged — all-time, recently, and per repository (see below)
- **Configurable polling** (1–30 min), notification toggles, optional hiding of draft review requests
- Popup updates live while open; toolbar badge shows pending review requests (`!` if the last update failed)

## Notes: daily todos

The popup's **Notes** tab is a lightweight daily todo list that works even when you're not signed in to GitHub.

- **Add** a todo with Enter; URLs in the text become clickable links
- **Check off** items — they move to a collapsible *Completed* section (with *Clear* + undo)
- **Edit** with double-click (or Enter on a focused item); Escape cancels
- **Reorder** by drag-and-drop, or Alt+↑ / Alt+↓
- **Delete** with undo
- **📌 Pin a PR**: the pin button on any PR card adds "Review owner/repo#123: title" (or "Follow up on …" for your
  own PRs) to today's list, with a link back to the PR; pinning twice doesn't duplicate it
- **Unfinished from earlier days** are surfaced on today's page with *Move all to today* (they remember where they came from)
- **Browse days** with ‹ / ›, plan ahead for tomorrow; click the date to jump back to today
- **Notes for the day**: a free-form, auto-saved text area per day (standup points, links, reminders)
- The tab badge shows today's open todos + overdue ones

Notes are stored in `chrome.storage.local` (this browser profile only). They are **kept when you disconnect GitHub**.
Completed todos older than 90 days are pruned automatically; open todos are never removed.
Use **Settings → Notes & todos** to **export** a JSON backup, **import** one (merged — nothing is overwritten or
duplicated), or delete everything.

## Focus monitor: "finish the review first, then enjoy the rest"

Opt-in (Settings → **Focus monitor**). When you've spent a while on distracting sites and work is waiting, you
get a notification like:

> **⏰ 1h on YouTube. A review is waiting for you**
> Instead of more YouTube, there's a pending review: alice's "Add idempotency keys" (acme/api#482).
> Finish it first, then enjoy the rest! 🎬
> *It's small (+40/−2), a quick win. bob already approved; yours may be the last one needed.*

with **Open it now** and **Snooze 60 min** buttons.

- **What it suggests**: the most useful review first (re-requested → small "quick wins" → oldest; drafts last).
  With no reviews pending it points to your PRs with unanswered conversations or requested changes, then to
  today's open todos. With nothing pending there is no reminder.
- **When**: after N minutes in a distraction session (10 min–2 h, default 30), then every M minutes (default 15).
  Breaks shorter than 5 minutes don't reset the session. Optional working-hours / weekdays-only mode.
- **How time is counted**: Chrome must be the focused app with the site in the front tab, and you must be active
  *or* the tab is playing audio (watching a video involves no mouse input). Music in a background tab while you
  work in another app doesn't count; a locked screen never counts; sleep gaps are capped.
- **Focus tab** in the popup: live session status, today's time per site, time on GitHub PR pages, reviews cleared,
  a 7-day chart (distracting vs. PR time) and insights (biggest distraction, comparison with your average,
  longest streak, how often you acted on reminders). Snooze or resume from there too.

**Privacy.** The extension requests host access *only for the sites you list* (Chrome's optional permissions), so
Chrome does not even reveal the URL of any other tab to it. Only per-day, per-site totals are stored (no URLs,
titles or visit times), in `chrome.storage.local`, for 30 days. Turning the monitor off removes the site access;
**Delete activity history** wipes the data.

## Stats: your contributions

The **Stats** tab answers "how much have I actually reviewed and shipped?", overall and per repository:

- **All-time totals**: PRs you reviewed (others' PRs you submitted a review on), your PRs that were merged, and
  your PRs opened (with merge rate and how many are still open).
- **Recently**: reviews submitted, PRs merged and PRs opened in the last 30 days and this year.
- **By repository**: the ~12 repositories you've been most active in recently, each with exact reviewed /
  merged / opened counts and merge rate, sortable by activity, reviewed, merged or name.

Numbers are exact: all-time and per-repo counts come from GitHub search totals (`reviewed-by:`,
`is:merged author:`, `repo:`), recent windows from GitHub's `contributionsCollection`. The per-repo *list* is
chosen from your latest 100 reviewed and 100 merged PRs, so a repository you were active in only long ago may
not be listed (the footer says how many were left out). Stats are fetched on demand when you open the tab,
cached for six hours, and refreshable with one click; they are cleared on disconnect.

## Organizations: why PRs can be missing

GitHub silently drops results the token is not allowed to see, so PRs from some orgs may not show up at first:

| Cause | How ActiveDev detects it | Fix |
|-------|--------------------------|-----|
| Token lacks `read:org` (logged in with an older version) | `X-OAuth-Scopes` header | Settings → **Re-authenticate** |
| Org has **OAuth App access restrictions** | GraphQL `FORBIDDEN` error on the org | Settings → Organization access → **Grant / request** (opens `github.com/settings/connections/applications/<client_id>`). Org owners click *Grant*; members click *Request* and an owner approves. |
| Org enforces **SAML SSO** | `X-GitHub-SSO: partial-results` header on search | **Authorize SSO** (opens `github.com/orgs/<org>/sso`) |

You can also grant org access directly on GitHub's consent screen during login.

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
   - `ALLOWED_EXTENSION_IDS` *(optional, recommended)* — comma-separated extension IDs allowed to log in
4. Deploy — done.

The server is stateless (HMAC-signed state tokens), so no database is needed.

### 3. Install the Extension

1. Open Chrome → `chrome://extensions` → Enable **Developer mode**
2. Click **Load unpacked** → select this folder
3. Set `SERVER_URL` in `lib/constants.js` to your deployment (e.g. `https://your-project.vercel.app`) and reload the extension
4. Click the extension icon → **Settings** → **Login with GitHub**

## Project Structure

```
ActiveDev/
├── api/index.js             # Vercel serverless entry point
├── vercel.json              # Vercel deployment config
├── package.json             # Root dependencies (for Vercel build)
├── manifest.json            # Extension manifest (MV3)
├── background.js            # Service worker: polling & notifications
├── lib/
│   ├── constants.js         # Shared constants, storage keys, default settings
│   ├── auth.js              # Server-based GitHub OAuth
│   ├── theme.js             # Light/dark/system theme
│   ├── github-api.js        # GitHub REST + GraphQL client, typed errors, org access checks
│   ├── pr-model.js          # Pure logic: review/thread analysis, change detection
│   ├── notes.js             # Daily notes/todos: pure state logic + serialized storage writes
│   ├── settings.js          # Settings read/merge helpers
│   ├── activity.js          # Focus monitor pure logic: classification, sessions, nudges, insights
│   ├── focus-monitor.js     # Focus monitor runtime: tab/idle events, time accounting, notifications
│   └── contributions.js     # Stats tab data: review/merge totals, per-repo counts (GraphQL search)
├── popup/
│   ├── popup.html / .js / .css
│   ├── notes-view.js        # Notes tab UI
│   ├── focus-view.js        # Focus tab UI (activity analysis)
│   ├── stats-view.js        # Stats tab UI (contributions)
│   └── dom.js               # Shared DOM helpers (safe element builder, toast queue)
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
├── scripts/check-coverage.mjs  # Runs the suite and enforces coverage minimums (see Tests)
├── tests/                   # node:test suites + a jsdom-based UI test harness
└── README.md
```

## UI/UX

- **Theme**: light, dark, or match-system, via the popup header toggle or the Settings dropdown. Applies
  instantly and stays in sync across any open popup/options pages.
- **Account menu**: click your avatar in the popup for quick **Settings** / **Disconnect**, instead of always
  going through the options page.
- **Loading skeletons** replace the PR lists the first time data loads, instead of briefly showing a misleading
  "nothing here" empty state.
- **Filter box** has a clear (✕) button once you've typed something.
- **Settings page** has a sticky quick-jump nav across the top (the page has grown long), which highlights the
  section currently in view.
- Visible focus outlines and `prefers-reduced-motion` support throughout.
- Toasts (e.g. "Todo deleted — Undo") now **queue** instead of one replacing another before you've seen it;
  plain confirmations are quick, but one with an Undo button stays up long enough to act on.

## Tests

```bash
npm install
npm test              # fast run, no coverage
npm run test:coverage # full run with a coverage report + enforced minimums (see below)
```

The suite (~220 tests) runs entirely offline. `tests/helpers/` provides an in-memory `chrome.*` mock, a fake
GitHub REST/GraphQL API, and (`dom-mock.js`) a small [jsdom](https://github.com/jsdom/jsdom)-based harness that
loads the real `popup.html` / `options.html` and drives the actual UI modules — clicking, typing, dragging,
keyboard shortcuts — rather than re-implementing their logic as a separate model. Each UI module exports its
`init`/`mount` function so tests can call it directly against a fresh DOM instead of needing a real
`DOMContentLoaded` event.

Coverage (line / branch / function), via `npm run test:coverage`:

| | Lines | Branches | Functions |
|---|---|---|---|
| **Overall** | **99%** | **87%** | **94%** |

Nearly every individual file is at 100% lines; the couple that aren't are either genuine tooling artifacts
(see below) or a defensive one-line `catch` body that's hard for a line-coverage tool to credit.

`npm run test:coverage` runs `scripts/check-coverage.mjs` rather than relying on Node's built-in
`--test-coverage-lines/-branches/-functions` CLI flags directly. Those flags work correctly in small examples,
but were found to silently **not** fail this project's full suite even when printed totals were below the given
threshold — most likely related to this suite's use of cache-busted dynamic imports (`import('x.js?t=...')`) to
get a fresh module instance per test for modules with internal state, which also fragments coverage attribution
for those specific modules across "instances" (e.g. `server/config.js`, which reads `process.env` once at import
time, needs a fresh import per test scenario). Rather than ship an enforcement mechanism that doesn't reliably
trigger, `check-coverage.mjs` parses the same report and checks the totals itself, so a coverage regression
actually fails `npm run test:coverage` (and CI).

What's covered: the PR model; the API client (typed errors, the SSO header, GraphQL partial failures); full
background polls (notifications, rate limiting, logout-on-401, the focus monitor wiring); the OAuth server
(including the token-exfiltration fix and the extension allowlist); notes (ordering, carry-over, undo, pruning,
import/merge, concurrent writes); the focus monitor (simulated browsing with a fake clock — thresholds, repeats,
snooze, idle/locked/audio rules, permissions, tab/window/idle event listeners, work hours); contribution stats
(query building, aggregation, exact-count merging, fetch batching and failure modes, caching/dedupe in the
background, and the Stats tab UI); and the popup/options UI itself (every tab, every banner, theme, the account menu, settings forms, drag-and-drop reordering, file
import/export, permission prompts, and more) via the jsdom harness.

Writing the UI tests caught several real bugs that manual testing had missed, including: a toast silently
rendering the literal text "null" when it had no action button; a few `chrome.*` event listeners that fired a
`.then()` chain without returning it, which meant `await`ing them from a caller did nothing; and the native
browser "clear" button on the filter field doubling up with the extension's own one.

## Security

- OAuth access token is stored in `chrome.storage.local` (not synced across devices)
- The Client Secret only lives on the server; the extension never sees it
- The server only redirects tokens to `https://<extension_id>.chromiumapp.org/` (no open redirect), optionally
  restricted further with `ALLOWED_EXTENSION_IDS`
- Tokens are returned in the URL fragment, never in a query string
- HMAC-signed, time-limited OAuth `state` parameter (CSRF protection)
- Automatic logout only when GitHub answers `401` (other errors keep you signed in and show a warning)
- Popup renders GitHub content with DOM text nodes (no HTML injection)

## Permissions

| Permission | Reason |
|-----------|--------|
| `identity` | GitHub OAuth via `chrome.identity.launchWebAuthFlow` |
| `alarms` | Periodic polling (configurable, default 3 minutes) |
| `notifications` | Chrome notifications for review events |
| `storage` | Store access token, PR data, settings, notes and focus totals locally |
| `idle` | Focus monitor: don't count time while you're away or the screen is locked |
| Optional host access (per site you list) | Focus monitor only, requested when you turn it on or add a site |
| `https://api.github.com/*` | GitHub API requests |
| `https://github.com/*` | GitHub OAuth authorization |
