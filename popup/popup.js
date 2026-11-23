import { STORAGE_KEYS } from '../lib/constants.js';
import { appSettingsUrl, logout } from '../lib/auth.js';
import { initTheme, nextTheme, setTheme, themeIcon } from '../lib/theme.js';
import { h, openUrl, setChildren, showToast } from './dom.js';
import { mountNotesView } from './notes-view.js';
import { mountFocusView } from './focus-view.js';
import { mountStatsView } from './stats-view.js';

const LAST_TAB_KEY = 'activedev:lastTab';

/** Set once the DOM is ready; PR cards use it for the 📌 "add to today" button. */
let notesView = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(dateString) {
  if (!dateString) return '';
  const date = new Date(dateString);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function plural(n, word, pluralWord = `${word}s`) {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** Chip = small labelled indicator. `tone` maps to a CSS colour class. */
function chip(text, tone = 'neutral', title = '') {
  return h('span', { className: `chip ${tone}`, title: title || undefined }, text);
}

const CI_CHIPS = {
  passing: ['✓ Checks passing', 'success'],
  failing: ['✗ Checks failing', 'danger'],
  pending: ['● Checks running', 'warning'],
};

const REVIEWER_STATE = {
  APPROVED: { symbol: '✓', tone: 'success', label: 'approved' },
  CHANGES_REQUESTED: { symbol: '✗', tone: 'danger', label: 'requested changes' },
  COMMENTED: { symbol: '💬', tone: 'neutral', label: 'commented' },
};

// ---------------------------------------------------------------------------
// Shared indicator builders
// ---------------------------------------------------------------------------

function reviewerTags(reviewers) {
  return reviewers.map((r) => {
    const info = REVIEWER_STATE[r.state] || REVIEWER_STATE.COMMENTED;
    return h(
      'span',
      { className: `reviewer-tag ${info.tone}`, title: `${r.login} ${info.label} ${formatRelativeTime(r.submittedAt)}` },
      `${info.symbol} ${r.login}`
    );
  });
}

/** Conversation indicator, phrased from the reviewer's or the author's point of view. */
function conversationChips(pr, perspective) {
  const t = pr.threads;
  if (!pr.detailsAvailable) return [];
  const chips = [];

  if (t.total === 0) {
    if (pr.commentCount > 0) chips.push(chip(`💬 ${plural(pr.commentCount, 'comment')}`, 'neutral', 'Comments on the PR conversation tab'));
    return chips;
  }

  const totalLabel = t.truncated ? `${t.total}+` : String(t.total);
  if (t.unresolved === 0) {
    chips.push(chip(`✓ All ${totalLabel} conversations resolved`, 'success'));
  } else {
    chips.push(
      chip(
        `💬 ${t.unresolved} unresolved · ${t.resolved} resolved`,
        'warning',
        `${plural(t.unresolved, 'unresolved conversation')}${t.outdated ? ` (${t.outdated} on outdated code)` : ''}`
      )
    );
    if (perspective === 'author' && t.awaitingViewer > 0) {
      chips.push(chip(`↩ ${t.awaitingViewer} awaiting your reply`, 'danger', 'Unresolved threads where the latest comment is not yours'));
    }
    if (perspective === 'reviewer' && t.startedByViewer > 0) {
      chips.push(chip(`${t.startedByViewer} of yours still open`, 'info', 'Unresolved threads you started'));
    }
  }
  if (pr.commentCount > 0) chips.push(chip(`🗨 ${plural(pr.commentCount, 'comment')}`, 'neutral', 'Comments on the PR conversation tab'));
  return chips;
}

function healthChips(pr) {
  const chips = [];
  const ci = CI_CHIPS[pr.ciState];
  if (ci) chips.push(chip(ci[0], ci[1]));
  if (pr.mergeable === 'CONFLICTING') chips.push(chip('⚠ Merge conflicts', 'danger'));
  if (pr.additions !== null && pr.deletions !== null) {
    chips.push(
      h(
        'span',
        { className: 'chip size', title: pr.changedFiles != null ? plural(pr.changedFiles, 'file') + ' changed' : '' },
        h('span', { className: 'add' }, `+${pr.additions}`),
        ' ',
        h('span', { className: 'del' }, `−${pr.deletions}`)
      )
    );
  }
  return chips;
}

function updatePinButton(button, pinned) {
  button.classList.toggle('pinned', pinned);
  button.title = pinned ? "In today's notes" : "Add to today's notes";
  button.setAttribute('aria-pressed', String(pinned));
}

/** 📌 button: adds the PR to today's todo list (verb: "Review" / "Follow up on"). */
function pinButton(pr, verb) {
  const button = h('button', { className: 'pin-btn', 'data-url': pr.htmlUrl, 'aria-label': "Add to today's notes" }, '📌');
  updatePinButton(button, !!notesView?.isPinned(pr.htmlUrl));
  button.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!notesView) return;
    const result = await notesView.pinPullRequest(pr, verb);
    updatePinButton(button, true);
    showToast(result === 'exists' ? "Already in today's notes" : "Added to today's notes", {
      label: 'View',
      onClick: () => document.querySelector('.tab[data-tab="notes"]').click(),
    });
  });
  button.addEventListener('keydown', (e) => e.stopPropagation());
  return button;
}

function prHeader(pr, pinVerb) {
  return h(
    'div',
    { className: 'pr-header' },
    h('span', { className: 'pr-title', title: pr.title }, pr.title),
    h('span', { className: 'pr-number' }, `#${pr.number}`),
    pinButton(pr, pinVerb)
  );
}

function prMeta(pr, { showAuthor }) {
  return h(
    'div',
    { className: 'pr-meta' },
    h('span', { className: 'pr-repo' }, pr.isPrivate ? '🔒 ' : '', `${pr.owner || '?'}/${pr.repo || '?'}`),
    pr.draft && h('span', { className: 'pr-draft' }, 'Draft'),
    showAuthor && h('span', {}, `by ${pr.author || 'unknown'}`),
    h('span', { title: `Updated ${new Date(pr.updatedAt).toLocaleString()}` }, `updated ${formatRelativeTime(pr.updatedAt)}`)
  );
}

function labelsRow(pr) {
  if (!pr.labels?.length) return null;
  return h(
    'div',
    { className: 'labels' },
    pr.labels.slice(0, 5).map((l) =>
      h('span', { className: 'label', style: { borderColor: `#${/^[0-9a-f]{6}$/i.test(l.color) ? l.color : '8b949e'}` } }, l.name)
    )
  );
}

function detailsUnavailableNote(pr) {
  if (pr.detailsAvailable) return null;
  return h('div', { className: 'pr-row muted' }, pr.detailsError || 'Review details not loaded yet.');
}

function prCard(pr, children) {
  const card = h('div', { className: 'pr-item', tabindex: '0', role: 'link' }, children);
  card.addEventListener('click', () => openUrl(pr.htmlUrl));
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openUrl(pr.htmlUrl);
  });
  return card;
}

// ---------------------------------------------------------------------------
// Review Requests tab
// ---------------------------------------------------------------------------

function reviewRequestCard(pr) {
  const requestChips = [];
  if (pr.viewerRequestVia === 'team') {
    requestChips.push(chip(`👥 via ${pr.requestedTeams.join(', ')}`, 'info', 'Requested from a team you belong to'));
  } else if (pr.viewerRequestVia === 'direct') {
    requestChips.push(chip('👤 Requested from you', 'info'));
  }
  if (pr.viewerReview) {
    requestChips.push(
      chip('🔁 Re-review requested', 'warning', `You reviewed ${formatRelativeTime(pr.viewerReview.submittedAt)}`)
    );
  }
  if (pr.newCommitsSinceViewerReview) requestChips.push(chip('New commits since your review', 'warning'));
  if (pr.viewerHasPendingReview) requestChips.push(chip('📝 Your review draft is not submitted', 'danger'));

  const others = pr.otherReviewers || [];
  let reviewedRow = null;
  if (pr.detailsAvailable) {
    reviewedRow = others.length
      ? h(
          'div',
          { className: 'pr-row reviewers' },
          h('span', { className: 'row-label' }, `Already reviewed by ${others.length}:`),
          reviewerTags(others)
        )
      : h('div', { className: 'pr-row muted' }, 'No one has reviewed yet');
  }

  return prCard(pr, [
    prHeader(pr, 'Review'),
    prMeta(pr, { showAuthor: true }),
    requestChips.length && h('div', { className: 'pr-row' }, requestChips),
    reviewedRow,
    h('div', { className: 'pr-row' }, conversationChips(pr, 'reviewer'), healthChips(pr)),
    labelsRow(pr),
    detailsUnavailableNote(pr),
  ]);
}

// ---------------------------------------------------------------------------
// My PRs tab
// ---------------------------------------------------------------------------

const DECISION_CHIPS = {
  APPROVED: ['✓ Approved', 'success'],
  CHANGES_REQUESTED: ['✗ Changes requested', 'danger'],
  REVIEW_REQUIRED: ['Review required', 'warning'],
};

function myPRCard(pr) {
  const statusChips = [];
  const decision = DECISION_CHIPS[pr.reviewDecision];
  if (decision) statusChips.push(chip(decision[0], decision[1], 'Review decision from branch protection rules'));
  else if (pr.reviewState === 'approved') statusChips.push(chip('✓ Approved', 'success'));
  else if (pr.reviewState === 'changes_requested') statusChips.push(chip('✗ Changes requested', 'danger'));
  else if (pr.detailsAvailable && pr.reviewers.length === 0) statusChips.push(chip('Awaiting first review', 'neutral'));

  const pending = (pr.requestedReviewers || []).map((r) => (r.type === 'team' ? r.slug : r.login));

  return prCard(pr, [
    prHeader(pr, 'Follow up on'),
    prMeta(pr, { showAuthor: false }),
    h('div', { className: 'pr-row' }, statusChips, healthChips(pr)),
    pr.reviewers?.length > 0 && h('div', { className: 'pr-row reviewers' }, reviewerTags(pr.reviewers)),
    pending.length > 0 &&
      h('div', { className: 'pr-row muted', title: 'Requested reviewers who have not reviewed yet' }, `⏳ Waiting on ${pending.join(', ')}`),
    h('div', { className: 'pr-row' }, conversationChips(pr, 'author')),
    labelsRow(pr),
    detailsUnavailableNote(pr),
  ]);
}

// ---------------------------------------------------------------------------
// Banners (org access, SSO, scopes, errors)
// ---------------------------------------------------------------------------

function banner(tone, message, action) {
  return h(
    'div',
    { className: `banner ${tone}` },
    h('span', {}, message),
    action && h('button', { className: 'banner-btn', onClick: action.onClick }, action.label)
  );
}

function buildBanners(status) {
  const banners = [];
  const settingsUrl = appSettingsUrl(status.appInfo);

  if (status.lastError) {
    const when = formatRelativeTime(status.lastError.at);
    banners.push(banner('danger', `Last update failed (${when}): ${status.lastError.message}`));
  }

  if (status.missingScopes?.length) {
    banners.push(
      banner(
        'warning',
        `Your login is missing the ${status.missingScopes.join(', ')} permission, so some organization PRs may be hidden.`,
        { label: 'Re-login', onClick: () => chrome.runtime.openOptionsPage() }
      )
    );
  }

  const ssoLogins = new Set();
  for (const org of status.ssoOrgs || []) if (org.login) ssoLogins.add(org.login);
  for (const org of status.orgs || []) if (org.access === 'sso_required') ssoLogins.add(org.login);
  const unknownSso = (status.ssoOrgs || []).filter((o) => !o.login).length;
  for (const login of ssoLogins) {
    banners.push(
      banner('warning', `${login} uses SAML SSO: its PRs are hidden until you authorize.`, {
        label: 'Authorize',
        onClick: () => openUrl(`https://github.com/orgs/${encodeURIComponent(login)}/sso`),
      })
    );
  }
  if (unknownSso > 0) {
    banners.push(
      banner('warning', `${plural(unknownSso, 'organization')} hid results because SAML SSO is not authorized.`, {
        label: 'Fix',
        onClick: () => openUrl(settingsUrl),
      })
    );
  }

  const restricted = (status.orgs || []).filter((o) => o.access === 'oauth_restricted').map((o) => o.login);
  if (restricted.length) {
    banners.push(
      banner(
        'warning',
        `${restricted.join(', ')} restrict${restricted.length === 1 ? 's' : ''} third-party apps: PRs there can't be fetched until access is granted.`,
        { label: 'Grant / request', onClick: () => openUrl(settingsUrl) }
      )
    );
  }

  return banners;
}

// ---------------------------------------------------------------------------
// Page wiring
// ---------------------------------------------------------------------------

/**
 * Wires up the popup. Exported (rather than only run as a DOMContentLoaded
 * side effect) so tests can build a DOM, import this module, and call it
 * directly without needing to fire a real DOMContentLoaded event.
 */
export async function initPopup() {
  const $ = (id) => document.getElementById(id);
  const elements = {
    loadingState: $('loading-state'),
    authRequired: $('auth-required'),
    errorState: $('error-state'),
    mainContent: $('main-content'),
    userSection: $('user-section'),
    avatar: $('avatar'),
    username: $('username'),
    errorMessage: $('error-message'),
    banners: $('banners'),
    reviewList: $('review-list'),
    reviewEmpty: $('review-empty'),
    myprsList: $('myprs-list'),
    myprsEmpty: $('myprs-empty'),
    reviewBadge: $('review-badge'),
    myprsBadge: $('myprs-badge'),
    notesBadge: $('notes-badge'),
    lastChecked: $('last-checked'),
    refreshBtn: $('refresh-btn'),
    retryBtn: $('retry-btn'),
    settingsBtn: $('settings-btn'),
    openOptionsBtn: $('open-options-btn'),
    filterInput: $('filter-input'),
    filterClear: $('filter-clear'),
    themeToggle: $('theme-toggle'),
    userMenuBtn: $('user-menu-btn'),
    userMenuPanel: $('user-menu-panel'),
    menuSettingsBtn: $('menu-settings-btn'),
    menuLogoutBtn: $('menu-logout-btn'),
  };

  await initTheme(document);

  let currentStatus = null;

  const focusView = mountFocusView($('focus-tab'));
  const statsView = mountStatsView($('stats-tab'));

  function selectTab(name) {
    const tab = document.querySelector(`.tab[data-tab="${name}"]`);
    if (!tab) return;
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
      t.setAttribute('aria-selected', String(t === tab));
    });
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    $(`${name}-tab`).classList.add('active');
    elements.mainContent.dataset.activeTab = name;
    if (name === 'focus') focusView.refresh();
    if (name === 'stats' && !elements.mainContent.classList.contains('unauth')) statsView.load();
    try {
      localStorage.setItem(LAST_TAB_KEY, name);
    } catch {
      /* storage unavailable: not important */
    }
  }
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));
  selectTab(localStorage.getItem(LAST_TAB_KEY) || 'review-requests');

  notesView = mountNotesView({
    onCountChange: (count) => {
      elements.notesBadge.classList.toggle('hidden', count === 0);
      elements.notesBadge.textContent = String(count);
    },
    onNotesChange: () => {
      document.querySelectorAll('.pin-btn').forEach((btn) => updatePinButton(btn, notesView.isPinned(btn.dataset.url)));
    },
  });
  const notesReady = notesView.reload();

  elements.openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  elements.settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
  elements.menuSettingsBtn.addEventListener('click', () => {
    closeUserMenu();
    chrome.runtime.openOptionsPage();
  });
  elements.menuLogoutBtn.addEventListener('click', async () => {
    closeUserMenu();
    await logout();
    await chrome.runtime.sendMessage({ type: 'USER_LOGGED_OUT' });
    showToast('Disconnected from GitHub.');
    await loadData();
  });

  function closeUserMenu() {
    elements.userMenuPanel.classList.add('hidden');
    elements.userMenuBtn.setAttribute('aria-expanded', 'false');
  }
  elements.userMenuBtn.addEventListener('click', () => {
    const open = elements.userMenuPanel.classList.toggle('hidden') === false;
    elements.userMenuBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!elements.userSection.contains(e.target)) closeUserMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeUserMenu();
  });

  async function updateThemeButton() {
    const theme = (await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS]?.theme || 'system';
    elements.themeToggle.textContent = themeIcon(theme);
    elements.themeToggle.title = `Switch theme (currently ${theme})`;
  }
  elements.themeToggle.addEventListener('click', async () => {
    const current = (await chrome.storage.local.get(STORAGE_KEYS.SETTINGS))[STORAGE_KEYS.SETTINGS]?.theme || 'system';
    await setTheme(nextTheme(current));
    await updateThemeButton();
  });
  await updateThemeButton();

  elements.filterInput.addEventListener('input', () => {
    elements.filterClear.classList.toggle('hidden', !elements.filterInput.value);
    currentStatus && render(currentStatus);
  });
  elements.filterClear.addEventListener('click', () => {
    elements.filterInput.value = '';
    elements.filterClear.classList.add('hidden');
    elements.filterInput.focus();
    currentStatus && render(currentStatus);
  });

  function matchesFilter(pr) {
    const q = elements.filterInput.value.trim().toLowerCase();
    if (!q) return true;
    return [pr.title, pr.owner, pr.repo, `${pr.owner}/${pr.repo}`, pr.author, `#${pr.number}`]
      .filter(Boolean)
      .some((v) => v.toLowerCase().includes(q));
  }

  function skeletonCard() {
    return h(
      'div',
      { className: 'skeleton-card' },
      h('div', { className: 'skeleton-line w-80' }),
      h('div', { className: 'skeleton-line w-40' })
    );
  }

  /** Shown the first time data is fetched, instead of a misleading "nothing here" empty state. */
  function renderSkeleton(listEl, emptyEl, badgeEl) {
    emptyEl.classList.add('hidden');
    badgeEl.classList.add('hidden');
    setChildren(listEl, h('div', { className: 'skeleton-list' }, [1, 2, 3].map(skeletonCard)));
  }

  function renderList(prs, listEl, emptyEl, badgeEl, cardFn) {
    badgeEl.classList.toggle('hidden', prs.length === 0);
    badgeEl.textContent = String(prs.length);

    const visible = prs.filter(matchesFilter);
    emptyEl.classList.toggle('hidden', visible.length > 0);
    if (prs.length > 0 && visible.length === 0) {
      emptyEl.replaceChildren(h('p', {}, 'No pull requests match the filter'));
    } else {
      emptyEl.replaceChildren(h('p', {}, emptyEl.dataset.defaultText));
    }
    setChildren(listEl, visible.map(cardFn));
  }

  function renderLastChecked() {
    const ts = currentStatus?.lastChecked;
    elements.lastChecked.textContent = ts ? `Updated ${formatRelativeTime(ts)}` : 'Not updated yet';
  }

  function render(status) {
    currentStatus = status;
    if (status.user) {
      elements.userSection.classList.remove('hidden');
      elements.avatar.src = status.user.avatar_url || `https://github.com/${encodeURIComponent(status.user.login)}.png?size=40`;
      elements.avatar.alt = status.user.login;
      elements.username.textContent = status.user.login;
    }
    elements.banners.replaceChildren(...buildBanners(status));
    if (status.lastChecked) {
      renderList(status.reviewRequests, elements.reviewList, elements.reviewEmpty, elements.reviewBadge, reviewRequestCard);
      renderList(status.myPRs, elements.myprsList, elements.myprsEmpty, elements.myprsBadge, myPRCard);
    } else {
      renderSkeleton(elements.reviewList, elements.reviewEmpty, elements.reviewBadge);
      renderSkeleton(elements.myprsList, elements.myprsEmpty, elements.myprsBadge);
    }
    renderLastChecked();
  }

  elements.reviewEmpty.dataset.defaultText = elements.reviewEmpty.textContent.trim();
  elements.myprsEmpty.dataset.defaultText = elements.myprsEmpty.textContent.trim();

  async function loadData({ silent = false } = {}) {
    if (!silent) {
      elements.loadingState.classList.remove('hidden');
      elements.errorState.classList.add('hidden');
      elements.mainContent.classList.add('hidden');
    }

    try {
      const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      elements.loadingState.classList.add('hidden');
      elements.mainContent.classList.remove('hidden');

      // Notes work without a GitHub account; only the PR tabs need one.
      const authenticated = !!status?.authenticated;
      elements.mainContent.classList.toggle('unauth', !authenticated);
      elements.refreshBtn.classList.toggle('hidden', !authenticated);
      if (!authenticated) {
        currentStatus = null;
        elements.userSection.classList.add('hidden');
        elements.banners.replaceChildren();
        elements.lastChecked.textContent = '';
        [elements.reviewBadge, elements.myprsBadge].forEach((b) => b.classList.add('hidden'));
        return;
      }

      render(status);

      // First run after login: no data yet, fetch immediately.
      if (!status.lastChecked && !silent) refresh();
    } catch (error) {
      elements.loadingState.classList.add('hidden');
      elements.errorState.classList.remove('hidden');
      elements.errorMessage.textContent = error.message || 'Failed to load data';
    }
  }

  async function refresh() {
    elements.refreshBtn.disabled = true;
    elements.refreshBtn.textContent = 'Checking…';
    try {
      await chrome.runtime.sendMessage({ type: 'CHECK_NOW' });
      await loadData({ silent: true });
    } finally {
      elements.refreshBtn.disabled = false;
      elements.refreshBtn.textContent = 'Refresh';
    }
  }

  elements.refreshBtn.addEventListener('click', refresh);
  elements.retryBtn.addEventListener('click', () => loadData());

  // Background polls while the popup is open update it live.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[STORAGE_KEYS.LAST_CHECKED] || changes[STORAGE_KEYS.LAST_ERROR] || changes[STORAGE_KEYS.ACCESS_TOKEN]) {
      loadData({ silent: true });
    }
  });
  setInterval(renderLastChecked, 30_000);
  setInterval(() => elements.mainContent.dataset.activeTab === 'focus' && focusView.refresh(), 30_000);

  await notesReady;
  await loadData();

  // Exposed for tests; harmless in production.
  return { loadData, refresh, selectTab, render, statsView };
}

document.addEventListener('DOMContentLoaded', initPopup);
