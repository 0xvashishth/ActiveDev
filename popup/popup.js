function formatRelativeTime(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

function formatLastChecked(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 1) return 'Updated just now';
  if (diffMins < 60) return `Updated ${diffMins}m ago`;
  return `Updated ${formatRelativeTime(timestamp)}`;
}

const stateClasses = {
  approved: { label: 'Approved', className: 'approved' },
  changes_requested: { label: 'Changes requested', className: 'changes_requested' },
  pending: { label: 'Pending review', className: 'pending' },
};

const ciStateClasses = {
  passing: { label: 'Checks passing', className: 'passing' },
  failing: { label: 'Checks failing', className: 'failing' },
  pending: { label: 'Checks pending', className: 'pending' },
  unknown: { label: '', className: 'unknown' },
};

document.addEventListener('DOMContentLoaded', async () => {
  const elements = {
    loadingState: document.getElementById('loading-state'),
    unauthState: document.getElementById('unauthenticated-state'),
    errorState: document.getElementById('error-state'),
    mainContent: document.getElementById('main-content'),
    userSection: document.getElementById('user-section'),
    avatar: document.getElementById('avatar'),
    username: document.getElementById('username'),
    errorMessage: document.getElementById('error-message'),
    reviewList: document.getElementById('review-list'),
    reviewEmpty: document.getElementById('review-empty'),
    myprsList: document.getElementById('myprs-list'),
    myprsEmpty: document.getElementById('myprs-empty'),
    reviewBadge: document.getElementById('review-badge'),
    myprsBadge: document.getElementById('myprs-badge'),
    lastChecked: document.getElementById('last-checked'),
    refreshBtn: document.getElementById('refresh-btn'),
    retryBtn: document.getElementById('retry-btn'),
    settingsBtn: document.getElementById('settings-btn'),
    openOptionsBtn: document.getElementById('open-options-btn'),
  };

  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      document.getElementById(`${tab.dataset.tab}-tab`).classList.add('active');
    });
  });

  elements.openOptionsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  elements.settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  async function loadData() {
    elements.loadingState.classList.remove('hidden');
    elements.unauthState.classList.add('hidden');
    elements.errorState.classList.add('hidden');
    elements.mainContent.classList.add('hidden');

    try {
      const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });

      elements.loadingState.classList.add('hidden');

      if (!status || !status.authenticated) {
        elements.unauthState.classList.remove('hidden');
        return;
      }

      renderUserInfo(status.user, elements);
      renderReviewRequests(status.reviewRequests, elements);
      renderMyPRs(status.myPRs, elements);
      renderLastChecked(status.lastChecked, elements);

      elements.mainContent.classList.remove('hidden');
    } catch (error) {
      elements.loadingState.classList.add('hidden');
      elements.errorState.classList.remove('hidden');
      elements.errorMessage.textContent = error.message || 'Failed to load data';
    }
  }

  elements.refreshBtn.addEventListener('click', async () => {
    elements.refreshBtn.disabled = true;
    elements.refreshBtn.textContent = 'Checking...';
    try {
      await chrome.runtime.sendMessage({ type: 'CHECK_NOW' });
      await loadData();
    } catch (error) {
      elements.errorState.classList.remove('hidden');
      elements.errorMessage.textContent = error.message;
    }
    elements.refreshBtn.disabled = false;
    elements.refreshBtn.textContent = 'Refresh';
  });

  elements.retryBtn.addEventListener('click', loadData);

  await loadData();
});

function renderUserInfo(user, elements) {
  elements.userSection.classList.remove('hidden');
  elements.avatar.src = user.avatar_url;
  elements.avatar.alt = user.login;
  elements.username.textContent = user.login;
}

function renderReviewRequests(prs, elements) {
  elements.reviewList.innerHTML = '';
  elements.reviewBadge.classList.add('hidden');

  if (!prs || prs.length === 0) {
    elements.reviewEmpty.classList.remove('hidden');
    return;
  }

  elements.reviewEmpty.classList.add('hidden');
  elements.reviewBadge.classList.remove('hidden');
  elements.reviewBadge.textContent = prs.length;

  prs.forEach(pr => {
    const item = document.createElement('div');
    item.className = 'pr-item';
    item.addEventListener('click', () => chrome.tabs.create({ url: pr.htmlUrl }));

    item.innerHTML = `
      <div class="pr-header">
        <span class="pr-title">${escapeHtml(pr.title)}</span>
        <span class="pr-number">#${pr.number}</span>
      </div>
      <div class="pr-meta">
        <span class="pr-repo">${escapeHtml(pr.owner)}/${escapeHtml(pr.repo)}</span>
        ${pr.draft ? '<span class="pr-draft">Draft</span>' : ''}
        <span>by ${escapeHtml(pr.author || 'unknown')}</span>
        <span>${formatRelativeTime(pr.createdAt)}</span>
      </div>
    `;

    elements.reviewList.appendChild(item);
  });
}

function renderMyPRs(prs, elements) {
  elements.myprsList.innerHTML = '';
  elements.myprsBadge.classList.add('hidden');

  if (!prs || prs.length === 0) {
    elements.myprsEmpty.classList.remove('hidden');
    return;
  }

  elements.myprsEmpty.classList.add('hidden');
  elements.myprsBadge.classList.remove('hidden');
  elements.myprsBadge.textContent = prs.length;

  prs.forEach(pr => {
    const item = document.createElement('div');
    item.className = 'pr-item';
    item.addEventListener('click', () => chrome.tabs.create({ url: pr.htmlUrl }));

    const ciInfo = ciStateClasses[pr.ciState] || ciStateClasses.unknown;
    const reviewInfo = stateClasses[pr.reviewState] || stateClasses.pending;

    const reviewersHtml = buildReviewersHtml(pr);

    item.innerHTML = `
      <div class="pr-header">
        <span class="pr-title">${escapeHtml(pr.title)}</span>
        <span class="status-dot ${reviewInfo.className}" title="${reviewInfo.label}"></span>
      </div>
      <div class="pr-meta">
        <span class="pr-repo">${escapeHtml(pr.owner)}/${escapeHtml(pr.repo)}</span>
        <span class="pr-number">#${pr.number}</span>
        ${pr.draft ? '<span class="pr-draft">Draft</span>' : ''}
        <span>${formatRelativeTime(pr.createdAt)}</span>
      </div>
      <div class="pr-status-row">
        ${ciInfo.label ? `<span class="ci-status ${ciInfo.className}">${ciInfo.label}</span>` : ''}
        ${reviewInfo.label !== 'Pending review' ? `<span>${reviewInfo.label}</span>` : ''}
        ${pr.totalReviews > 0 ? `<span>${pr.totalReviews} review${pr.totalReviews > 1 ? 's' : ''}</span>` : ''}
      </div>
      ${reviewersHtml ? `<div class="reviewers">${reviewersHtml}</div>` : ''}
    `;

    elements.myprsList.appendChild(item);
  });
}

function buildReviewersHtml(pr) {
  const parts = [];

  if (pr.approvals && pr.approvals.length > 0) {
    pr.approvals.forEach(user => {
      parts.push(`<span class="reviewer-tag approved">${escapeHtml(user)} ✓</span>`);
    });
  }

  if (pr.changesRequested && pr.changesRequested.length > 0) {
    pr.changesRequested.forEach(user => {
      parts.push(`<span class="reviewer-tag changes">${escapeHtml(user)} ✗</span>`);
    });
  }

  return parts.join('');
}

function renderLastChecked(timestamp, elements) {
  elements.lastChecked.textContent = formatLastChecked(timestamp);
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
