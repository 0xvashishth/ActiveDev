import { STORAGE_KEYS } from '../lib/constants.js';
import { sortRepos } from '../lib/contributions.js';
import { h, openUrl, setChildren } from './dom.js';

const SORTS = [
  ['activity', 'Most active'],
  ['reviewed', 'Reviewed'],
  ['merged', 'Merged'],
  ['name', 'Name'],
];

function formatCount(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n ?? 0);
}

function formatAgo(ts) {
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

function tile(value, label, tone = '', title = '', sub = null) {
  return h(
    'div',
    { className: `stat ${tone}`, title: title || undefined },
    h('div', { className: 'stat-value' }, value),
    h('div', { className: 'stat-label' }, label),
    sub && h('div', { className: 'stat-sub' }, sub)
  );
}

function windowRow(label, w) {
  return h(
    'div',
    { className: 'window-row' },
    h('span', { className: 'window-label' }, label),
    h('span', {}, h('strong', {}, formatCount(w.reviewsSubmitted)), ' reviews'),
    h('span', {}, h('strong', {}, formatCount(w.prsMerged)), ' merged'),
    h('span', {}, h('strong', {}, formatCount(w.prsOpened)), ' opened')
  );
}

function repoRow(repo, max) {
  const width = (n) => `${max ? Math.max(n > 0 ? 3 : 0, (n / max) * 100) : 0}%`;
  const rate = repo.authored ? Math.round((repo.merged / repo.authored) * 100) : null;
  return h(
    'li',
    { className: 'repo-row' },
    h(
      'div',
      { className: 'repo-head' },
      h(
        'a',
        {
          href: repo.url,
          className: 'repo-name',
          title: repo.nameWithOwner,
          onClick: (e) => {
            e.preventDefault();
            openUrl(repo.url);
          },
        },
        repo.isPrivate ? '🔒 ' : '',
        repo.nameWithOwner
      ),
      !repo.exact && h('span', { className: 'chip neutral', title: 'Counted from your most recent activity only; exact totals were unavailable.' }, '~ recent only')
    ),
    h(
      'div',
      { className: 'repo-metrics' },
      h(
        'div',
        { className: 'metric' },
        h('span', { className: 'metric-label' }, 'Reviewed'),
        h('span', { className: 'bar-track' }, h('span', { className: 'bar-fill reviewed', style: { width: width(repo.reviewed) } })),
        h('span', { className: 'metric-value' }, formatCount(repo.reviewed))
      ),
      h(
        'div',
        { className: 'metric' },
        h('span', { className: 'metric-label' }, 'Merged'),
        h('span', { className: 'bar-track' }, h('span', { className: 'bar-fill merged', style: { width: width(repo.merged) } })),
        h('span', { className: 'metric-value' }, formatCount(repo.merged))
      )
    ),
    h(
      'div',
      { className: 'repo-foot' },
      `${formatCount(repo.authored)} PR${repo.authored === 1 ? '' : 's'} opened`,
      rate !== null && ` · ${rate}% merged`
    )
  );
}

/**
 * Mounts the Stats tab into `container`.
 * Data comes from the background (cached in storage); refreshes are explicit
 * or triggered automatically when the cache is stale.
 */
export function mountStatsView(container) {
  let data = null;
  let sortBy = 'activity';
  let refreshing = false;
  let lastError = null;

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    lastError = null;
    render();
    try {
      const result = await chrome.runtime.sendMessage({ type: 'REFRESH_CONTRIBUTIONS' });
      if (result?.success) data = result.data;
      else lastError = result?.error || 'Could not load contribution stats.';
    } catch (error) {
      lastError = error.message;
    } finally {
      refreshing = false;
      render();
    }
  }

  async function load() {
    let status;
    try {
      status = await chrome.runtime.sendMessage({ type: 'GET_CONTRIBUTIONS' });
    } catch (error) {
      lastError = error.message;
      render();
      return;
    }
    if (!status?.authenticated) {
      data = null;
      render();
      return;
    }
    data = status.data;
    render();
    if (status.stale && !status.refreshing) await refresh();
  }

  function header() {
    return h(
      'div',
      { className: 'stats-header' },
      h(
        'div',
        {},
        h('strong', {}, 'Your contributions'),
        data && h('span', { className: 'muted small' }, ` · updated ${formatAgo(data.fetchedAt)}`)
      ),
      h(
        'button',
        { className: 'icon-btn', title: 'Refresh stats', 'aria-label': 'Refresh stats', disabled: refreshing || undefined, onClick: refresh },
        refreshing ? 'Refreshing…' : '↻ Refresh'
      )
    );
  }

  function render() {
    if (!data && refreshing) {
      setChildren(
        container,
        header(),
        h('div', { className: 'stats-loading' }, h('div', { className: 'spinner' }), h('p', { className: 'muted small' }, 'Counting your reviews and merges on GitHub…'))
      );
      return;
    }
    if (!data) {
      setChildren(
        container,
        header(),
        h(
          'div',
          { className: 'focus-intro' },
          h('div', { className: 'state-icon' }, '📊'),
          h('p', { className: 'state-title' }, lastError ? 'Could not load stats' : 'No stats yet'),
          h('p', { className: 'state-desc' }, lastError || 'See how many pull requests you have reviewed and merged, overall and per repository.'),
          h('button', { className: 'btn-primary', onClick: refresh }, lastError ? 'Try again' : 'Load my stats')
        )
      );
      return;
    }

    const { totals, windows } = data;
    const repos = sortRepos(data.repos, sortBy);
    const max = Math.max(1, ...repos.map((r) => Math.max(r.reviewed, r.merged)));

    setChildren(
      container,
      header(),
      lastError && h('div', { className: 'banner danger stats-banner' }, h('span', {}, `Refresh failed: ${lastError}. Showing the last saved numbers.`)),
      h(
        'div',
        { className: 'stats' },
        tile(formatCount(totals.prsReviewed), 'PRs reviewed', 'good', 'Pull requests by others that you reviewed (all time)'),
        tile(formatCount(totals.prsMerged), 'PRs merged', 'good', 'Your pull requests that were merged (all time)'),
        tile(
          formatCount(totals.prsAuthored),
          'PRs opened',
          '',
          `${totals.prsOpen} still open`,
          totals.mergeRate === null ? null : `${totals.mergeRate}% merged`
        )
      ),
      h('section', { className: 'focus-section' }, h('h3', {}, 'Recently'), windowRow('Last 30 days', windows.last30), windowRow('This year', windows.thisYear)),
      h(
        'section',
        { className: 'focus-section' },
        h(
          'div',
          { className: 'section-head' },
          h('h3', {}, 'By repository'),
          h(
            'div',
            { className: 'segmented', role: 'group', 'aria-label': 'Sort repositories' },
            SORTS.map(([key, label]) =>
              h(
                'button',
                {
                  className: `seg${sortBy === key ? ' active' : ''}`,
                  'aria-pressed': String(sortBy === key),
                  onClick: () => {
                    sortBy = key;
                    render();
                  },
                },
                label
              )
            )
          )
        ),
        repos.length
          ? h('ul', { className: 'repo-list' }, repos.map((repo) => repoRow(repo, max)))
          : h('p', { className: 'muted small' }, 'No reviewed or merged pull requests found yet.'),
        h(
          'p',
          { className: 'focus-footer' },
          `Totals are all-time. Repositories are the ${repos.length} you've been most active in recently` +
            (data.coverage?.reposOmitted ? ` (${data.coverage.reposOmitted} more not shown)` : '') +
            '; their numbers are exact unless marked "~".'
        )
      )
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEYS.CONTRIBUTIONS]?.newValue) {
      data = changes[STORAGE_KEYS.CONTRIBUTIONS].newValue;
      render();
    }
  });

  return {
    load,
    refresh,
    /** Exposed for tests. */
    getState: () => ({ data, sortBy, refreshing, lastError }),
  };
}
