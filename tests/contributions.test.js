import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { installFetchMock, jsonResponse } from './helpers/github-mock.js';
import { STORAGE_KEYS } from '../lib/constants.js';
import {
  MAX_REPOS,
  REPOS_PER_REQUEST,
  SAMPLE_SIZE,
  STALE_AFTER_MS,
  aggregateRepoSamples,
  applyRepoCounts,
  buildOverview,
  fetchContributions,
  isStale,
  mergeRate,
  normalizeContributions,
  overviewVariables,
  repoCountsQuery,
  sortRepos,
} from '../lib/contributions.js';

const repoNode = (nameWithOwner, isPrivate = false) => ({
  repository: { nameWithOwner, url: `https://github.com/${nameWithOwner}`, isPrivate },
});

function overviewData({ reviewed = [], merged = [], counts = {} } = {}) {
  return {
    reviewed: { issueCount: counts.reviewed ?? reviewed.length, nodes: reviewed },
    merged: { issueCount: counts.merged ?? merged.length, nodes: merged },
    authored: { issueCount: counts.authored ?? 40 },
    open: { issueCount: counts.open ?? 3 },
    merged30: { issueCount: counts.merged30 ?? 4 },
    mergedYear: { issueCount: counts.mergedYear ?? 20 },
    user: {
      createdAt: '2019-01-01T00:00:00Z',
      last30: { totalPullRequestReviewContributions: 12, totalPullRequestContributions: 5 },
      thisYear: { totalPullRequestReviewContributions: 88, totalPullRequestContributions: 30 },
    },
  };
}

test('overviewVariables builds the right search qualifiers and date windows', () => {
  const now = Date.UTC(2024, 4, 15, 12); // 15 May 2024
  const v = overviewVariables('octo', now);
  assert.equal(v.login, 'octo');
  assert.equal(v.reviewedQ, 'is:pr reviewed-by:octo -author:octo sort:updated-desc');
  assert.equal(v.mergedQ, 'is:pr is:merged author:octo sort:updated-desc');
  assert.equal(v.authoredQ, 'is:pr author:octo');
  assert.equal(v.openQ, 'is:pr author:octo is:open');
  assert.equal(v.merged30Q, 'is:pr is:merged author:octo merged:>=2024-04-15');
  assert.match(v.mergedYearQ, /merged:>=2024-01-01$/);
  assert.equal(v.since30, new Date(now - 30 * 86_400_000).toISOString());
  assert.equal(new Date(v.sinceYear).getFullYear(), 2024);
});

test('repoCountsQuery aliases three exact searches per repository', () => {
  const { query, variables } = repoCountsQuery('octo', ['acme/api', 'acme/web']);
  assert.match(query, /r0_reviewed: search\(query: \$q0_reviewed/);
  assert.match(query, /r1_authored: search\(query: \$q1_authored/);
  assert.equal(variables.q0_reviewed, 'is:pr reviewed-by:octo -author:octo repo:acme/api');
  assert.equal(variables.q1_merged, 'is:pr is:merged author:octo repo:acme/web');
  assert.equal(Object.keys(variables).length, 6);
});

test('aggregateRepoSamples counts per repo across both samples and orders by activity', () => {
  const repos = aggregateRepoSamples(
    [repoNode('acme/api'), repoNode('acme/api'), repoNode('acme/web'), { repository: null }, null],
    [repoNode('acme/web'), repoNode('acme/web', true), repoNode('me/dotfiles')]
  );
  assert.deepEqual(
    repos.map((r) => [r.nameWithOwner, r.reviewed, r.merged, r.exact]),
    [
      ['acme/web', 1, 2, false],
      ['acme/api', 2, 0, false],
      ['me/dotfiles', 0, 1, false],
    ]
  );
  assert.equal(repos[0].isPrivate, false, 'the first sighting of a repo decides its metadata');
});

test('applyRepoCounts replaces sampled numbers with exact ones, leaving repos alone when data is missing', () => {
  const repos = [
    { nameWithOwner: 'a/b', reviewed: 2, merged: 1, authored: 0, exact: false },
    { nameWithOwner: 'c/d', reviewed: 1, merged: 0, authored: 0, exact: false },
  ];
  const result = applyRepoCounts(repos, {
    r0_reviewed: { issueCount: 42 },
    r0_merged: { issueCount: 17 },
    r0_authored: { issueCount: 20 },
    r1_reviewed: { issueCount: 5 },
    // r1_merged missing
    r1_authored: { issueCount: 2 },
  });
  assert.deepEqual(result[0], { nameWithOwner: 'a/b', reviewed: 42, merged: 17, authored: 20, exact: true });
  assert.equal(result[1].exact, false);
  assert.equal(result[1].reviewed, 1);
});

test('sortRepos supports every sort key with a stable name tiebreak', () => {
  const repos = [
    { nameWithOwner: 'b/b', reviewed: 5, merged: 1 },
    { nameWithOwner: 'a/a', reviewed: 5, merged: 1 },
    { nameWithOwner: 'c/c', reviewed: 1, merged: 9 },
  ];
  assert.deepEqual(sortRepos(repos, 'activity').map((r) => r.nameWithOwner), ['c/c', 'a/a', 'b/b']);
  assert.deepEqual(sortRepos(repos, 'reviewed').map((r) => r.nameWithOwner), ['a/a', 'b/b', 'c/c']);
  assert.deepEqual(sortRepos(repos, 'merged').map((r) => r.nameWithOwner), ['c/c', 'a/a', 'b/b']);
  assert.deepEqual(sortRepos(repos, 'name').map((r) => r.nameWithOwner), ['a/a', 'b/b', 'c/c']);
  assert.notEqual(sortRepos(repos), repos, 'does not mutate the input');
});

test('mergeRate handles zero authored PRs', () => {
  assert.equal(mergeRate(3, 4), 75);
  assert.equal(mergeRate(0, 0), null);
});

test('buildOverview maps totals, windows, sampled repos and coverage', () => {
  const reviewed = Array.from({ length: SAMPLE_SIZE }, (_, i) => repoNode(`org/r${i % 15}`));
  const data = overviewData({ reviewed, merged: [repoNode('org/r0')], counts: { reviewed: 250, merged: 1 } });
  const model = buildOverview(data, { login: 'octo', now: 1000 });

  assert.equal(model.login, 'octo');
  assert.equal(model.fetchedAt, 1000);
  assert.deepEqual(model.totals, { prsReviewed: 250, prsMerged: 1, prsAuthored: 40, prsOpen: 3, mergeRate: 3 });
  assert.deepEqual(model.windows.last30, { reviewsSubmitted: 12, prsOpened: 5, prsMerged: 4 });
  assert.deepEqual(model.windows.thisYear, { reviewsSubmitted: 88, prsOpened: 30, prsMerged: 20 });
  assert.equal(model.repos.length, MAX_REPOS, 'capped to the most active repositories');
  assert.equal(model.repos[0].nameWithOwner, 'org/r0', 'r0 appears in both samples, so it is the most active');
  assert.deepEqual(model.coverage, { reviewedSampled: 100, mergedSampled: 1, reposOmitted: 15 - MAX_REPOS, truncated: true });
});

test('buildOverview copes with a missing user / empty response', () => {
  const model = buildOverview({}, { login: 'octo' });
  assert.equal(model.totals.prsReviewed, 0);
  assert.equal(model.totals.mergeRate, null);
  assert.deepEqual(model.repos, []);
  assert.equal(model.windows.last30.reviewsSubmitted, 0);
});

test('isStale / normalizeContributions', () => {
  assert.equal(isStale(null), true);
  assert.equal(isStale({ fetchedAt: Date.now() }), false);
  assert.equal(isStale({ fetchedAt: Date.now() - STALE_AFTER_MS - 1 }), true);

  assert.equal(normalizeContributions(null), null);
  assert.equal(normalizeContributions({ version: 99, totals: {} }), null);
  assert.equal(normalizeContributions({ version: 1 }), null, 'no totals → unusable');
  assert.deepEqual(normalizeContributions({ version: 1, totals: { prsReviewed: 1 } }).repos, []);
});

// ---------------------------------------------------------------------------
// fetchContributions (mocked GraphQL)
// ---------------------------------------------------------------------------

let fetchMock;
beforeEach(async () => {
  installChromeMock();
  await chrome.storage.local.set({ [STORAGE_KEYS.ACCESS_TOKEN]: 'tok' });
});
afterEach(() => fetchMock?.restore());

test('fetchContributions: one overview request, then batched exact per-repo counts', async () => {
  const requests = [];
  fetchMock = installFetchMock([
    [
      'https://api.github.com/graphql',
      (url, body) => {
        requests.push(body);
        if (body.query.includes('ContributionsOverview')) {
          const reviewed = [];
          for (let i = 0; i < 8; i++) reviewed.push(repoNode(`org/repo${i}`));
          return jsonResponse({ data: overviewData({ reviewed, merged: [repoNode('org/repo0'), repoNode('org/repo0')] }) });
        }
        // Per-repo: exact counts = 10× the alias index, so results are easy to check.
        const data = {};
        for (const key of Object.keys(body.variables)) {
          const [, i, kind] = key.match(/^q(\d+)_(\w+)$/);
          data[`r${i}_${kind}`] = { issueCount: Number(i) * 10 + { reviewed: 1, merged: 2, authored: 3 }[kind] };
        }
        return jsonResponse({ data });
      },
    ],
  ]);

  const result = await fetchContributions('octo', { now: 5000 });
  assert.equal(requests.length, 1 + Math.ceil(8 / REPOS_PER_REQUEST), 'overview + 2 per-repo batches for 8 repos');
  assert.equal(result.fetchedAt, 5000);
  assert.equal(result.repos.length, 8);
  assert.ok(result.repos.every((r) => r.exact));
  const repo0 = result.repos.find((r) => r.nameWithOwner === 'org/repo0');
  assert.deepEqual([repo0.reviewed, repo0.merged, repo0.authored], [1, 2, 3], 'exact numbers replaced the sampled ones');
  assert.equal(result.repos[0].nameWithOwner, result.repos.map((r) => r).sort((a, b) => b.reviewed + b.merged - (a.reviewed + a.merged))[0].nameWithOwner, 'final order is by exact activity');
});

test('fetchContributions: a failed per-repo batch keeps sampled counts (marked inexact) instead of failing', async () => {
  let graphqlCalls = 0;
  fetchMock = installFetchMock([
    [
      'https://api.github.com/graphql',
      (url, body) => {
        graphqlCalls++;
        if (body.query.includes('ContributionsOverview')) {
          return jsonResponse({ data: overviewData({ reviewed: [repoNode('a/b'), repoNode('a/b')], merged: [repoNode('c/d')] }) });
        }
        return jsonResponse({ message: 'boom' }, { status: 502 });
      },
    ],
  ]);
  const result = await fetchContributions('octo');
  assert.equal(graphqlCalls, 2);
  assert.deepEqual(result.repos.map((r) => [r.nameWithOwner, r.reviewed, r.merged, r.exact]), [
    ['a/b', 2, 0, false],
    ['c/d', 0, 1, false],
  ]);
});

test('fetchContributions: rate limiting during per-repo counts propagates; an empty GraphQL answer is an error', async () => {
  fetchMock = installFetchMock([
    [
      'https://api.github.com/graphql',
      (url, body) =>
        body.query.includes('ContributionsOverview')
          ? jsonResponse({ data: overviewData({ reviewed: [repoNode('a/b')] }) })
          : jsonResponse({ message: 'limit' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' } }),
    ],
  ]);
  await assert.rejects(fetchContributions('octo'), { kind: 'rate_limited' });

  fetchMock.restore();
  fetchMock = installFetchMock([
    ['https://api.github.com/graphql', () => jsonResponse({ data: { user: null }, errors: [{ message: 'Could not resolve to a User' }] })],
  ]);
  await assert.rejects(fetchContributions('ghost'), /Could not resolve to a User/);
});
