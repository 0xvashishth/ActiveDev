/**
 * Contribution statistics for the Stats tab: how many PRs the user has
 * reviewed and merged, overall and per repository.
 *
 * Data comes from two batched GraphQL requests:
 *  1. Overview — exact all-time totals via search `issueCount`
 *     (`reviewed-by:`, `is:merged author:` …), exact recent-window counts via
 *     `contributionsCollection`, and a sample of the most recently active
 *     reviewed/merged PRs so we know which repositories to break down.
 *  2. Per-repository — exact counts for the most active repositories, as
 *     aliased `search { issueCount }` fields in one request.
 *
 * Everything below `fetchContributions` is pure and unit-tested without
 * network access.
 */
import { graphqlRequest } from './github-api.js';

export const CONTRIBUTIONS_VERSION = 1;
export const SAMPLE_SIZE = 100;
export const MAX_REPOS = 12;
export const REPOS_PER_REQUEST = 6; // 3 searches each → 18 aliased searches per request
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

export function reviewedQuery(login, extra = '') {
  return `is:pr reviewed-by:${login} -author:${login} ${extra}`.trim();
}

export function mergedQuery(login, extra = '') {
  return `is:pr is:merged author:${login} ${extra}`.trim();
}

export function authoredQuery(login, extra = '') {
  return `is:pr author:${login} ${extra}`.trim();
}

export const OVERVIEW_QUERY = `
  query ContributionsOverview(
    $login: String!
    $reviewedQ: String!
    $mergedQ: String!
    $authoredQ: String!
    $openQ: String!
    $merged30Q: String!
    $mergedYearQ: String!
    $since30: DateTime!
    $sinceYear: DateTime!
  ) {
    reviewed: search(query: $reviewedQ, type: ISSUE, first: ${SAMPLE_SIZE}) {
      issueCount
      nodes { ... on PullRequest { repository { nameWithOwner url isPrivate } } }
    }
    merged: search(query: $mergedQ, type: ISSUE, first: ${SAMPLE_SIZE}) {
      issueCount
      nodes { ... on PullRequest { repository { nameWithOwner url isPrivate } } }
    }
    authored: search(query: $authoredQ, type: ISSUE, first: 1) { issueCount }
    open: search(query: $openQ, type: ISSUE, first: 1) { issueCount }
    merged30: search(query: $merged30Q, type: ISSUE, first: 1) { issueCount }
    mergedYear: search(query: $mergedYearQ, type: ISSUE, first: 1) { issueCount }
    user(login: $login) {
      createdAt
      last30: contributionsCollection(from: $since30) {
        totalPullRequestReviewContributions
        totalPullRequestContributions
      }
      thisYear: contributionsCollection(from: $sinceYear) {
        totalPullRequestReviewContributions
        totalPullRequestContributions
      }
    }
  }
`;

function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function overviewVariables(login, now = Date.now()) {
  const since30 = new Date(now - 30 * 86_400_000);
  // UTC so the `merged:>=YYYY-MM-DD` qualifier never drifts to Dec 31 in UTC+ zones.
  const yearStart = new Date(Date.UTC(new Date(now).getUTCFullYear(), 0, 1));
  // contributionsCollection(from:) must be within the last year; Jan 1 always is.
  return {
    login,
    reviewedQ: reviewedQuery(login, 'sort:updated-desc'),
    mergedQ: mergedQuery(login, 'sort:updated-desc'),
    authoredQ: authoredQuery(login),
    openQ: authoredQuery(login, 'is:open'),
    merged30Q: mergedQuery(login, `merged:>=${isoDate(since30.getTime())}`),
    mergedYearQ: mergedQuery(login, `merged:>=${isoDate(yearStart.getTime())}`),
    since30: since30.toISOString(),
    sinceYear: yearStart.toISOString(),
  };
}

/** Builds one GraphQL request asking for exact reviewed/merged/authored counts in each repo. */
export function repoCountsQuery(login, repos) {
  const varDefs = [];
  const fields = [];
  const variables = {};
  repos.forEach((repo, i) => {
    for (const [kind, build] of [
      ['reviewed', reviewedQuery],
      ['merged', mergedQuery],
      ['authored', authoredQuery],
    ]) {
      const name = `q${i}_${kind}`;
      varDefs.push(`$${name}: String!`);
      fields.push(`r${i}_${kind}: search(query: $${name}, type: ISSUE, first: 1) { issueCount }`);
      variables[name] = build(login, `repo:${repo}`);
    }
  });
  return { query: `query RepoCounts(${varDefs.join(', ')}) { ${fields.join('\n')} }`, variables };
}

// ---------------------------------------------------------------------------
// Aggregation (pure)
// ---------------------------------------------------------------------------

function repoOf(node) {
  const repo = node?.repository;
  return repo?.nameWithOwner ? repo : null;
}

/**
 * Counts how often each repository appears in the reviewed/merged samples
 * and orders repositories by recent activity (most active first).
 */
export function aggregateRepoSamples(reviewedNodes, mergedNodes) {
  const repos = new Map();
  const bump = (node, field) => {
    const repo = repoOf(node);
    if (!repo) return;
    const entry = repos.get(repo.nameWithOwner) || {
      nameWithOwner: repo.nameWithOwner,
      url: repo.url || `https://github.com/${repo.nameWithOwner}`,
      isPrivate: !!repo.isPrivate,
      reviewed: 0,
      merged: 0,
      authored: 0,
      exact: false,
    };
    entry[field] += 1;
    repos.set(repo.nameWithOwner, entry);
  };
  for (const node of reviewedNodes || []) bump(node, 'reviewed');
  for (const node of mergedNodes || []) bump(node, 'merged');

  return [...repos.values()].sort(
    (a, b) => b.reviewed + b.merged - (a.reviewed + a.merged) || a.nameWithOwner.localeCompare(b.nameWithOwner)
  );
}

/** Replaces sampled counts with exact ones where the per-repo request succeeded. */
export function applyRepoCounts(repos, data) {
  return repos.map((repo, i) => {
    const reviewed = data?.[`r${i}_reviewed`]?.issueCount;
    const merged = data?.[`r${i}_merged`]?.issueCount;
    const authored = data?.[`r${i}_authored`]?.issueCount;
    if ([reviewed, merged, authored].some((v) => typeof v !== 'number')) return repo;
    return { ...repo, reviewed, merged, authored, exact: true };
  });
}

export function sortRepos(repos, by = 'activity') {
  const list = [...repos];
  switch (by) {
    case 'reviewed':
      return list.sort((a, b) => b.reviewed - a.reviewed || a.nameWithOwner.localeCompare(b.nameWithOwner));
    case 'merged':
      return list.sort((a, b) => b.merged - a.merged || a.nameWithOwner.localeCompare(b.nameWithOwner));
    case 'name':
      return list.sort((a, b) => a.nameWithOwner.localeCompare(b.nameWithOwner));
    default:
      return list.sort(
        (a, b) => b.reviewed + b.merged - (a.reviewed + a.merged) || a.nameWithOwner.localeCompare(b.nameWithOwner)
      );
  }
}

export function mergeRate(merged, authored) {
  if (!authored) return null;
  return Math.round((merged / authored) * 100);
}

/** Turns the overview response into the stored model (before per-repo counts are applied). */
export function buildOverview(data, { login, now = Date.now() }) {
  const count = (key) => data?.[key]?.issueCount ?? 0;
  const user = data?.user || {};
  const prsMerged = count('merged');
  const prsAuthored = count('authored');
  const sampleRepos = aggregateRepoSamples(data?.reviewed?.nodes, data?.merged?.nodes);

  return {
    version: CONTRIBUTIONS_VERSION,
    login,
    fetchedAt: now,
    accountCreatedAt: user.createdAt || null,
    totals: {
      prsReviewed: count('reviewed'),
      prsMerged,
      prsAuthored,
      prsOpen: count('open'),
      mergeRate: mergeRate(prsMerged, prsAuthored),
    },
    windows: {
      last30: {
        reviewsSubmitted: user.last30?.totalPullRequestReviewContributions ?? 0,
        prsOpened: user.last30?.totalPullRequestContributions ?? 0,
        prsMerged: count('merged30'),
      },
      thisYear: {
        reviewsSubmitted: user.thisYear?.totalPullRequestReviewContributions ?? 0,
        prsOpened: user.thisYear?.totalPullRequestContributions ?? 0,
        prsMerged: count('mergedYear'),
      },
    },
    repos: sampleRepos.slice(0, MAX_REPOS),
    coverage: {
      // How representative the per-repo list is: if the samples were
      // truncated, there may be repositories (older activity) not shown.
      reviewedSampled: Math.min(count('reviewed'), data?.reviewed?.nodes?.length ?? 0),
      mergedSampled: Math.min(count('merged'), data?.merged?.nodes?.length ?? 0),
      reposOmitted: Math.max(0, sampleRepos.length - MAX_REPOS),
      truncated: count('reviewed') > SAMPLE_SIZE || count('merged') > SAMPLE_SIZE,
    },
  };
}

export function isStale(contributions, now = Date.now()) {
  return !contributions?.fetchedAt || now - contributions.fetchedAt > STALE_AFTER_MS;
}

export function normalizeContributions(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== CONTRIBUTIONS_VERSION || !raw.totals) return null;
  return { ...raw, repos: Array.isArray(raw.repos) ? raw.repos : [] };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Fetches everything the Stats tab needs. Per-repo exactness is best-effort:
 * if that request fails, the sampled counts are kept (marked `exact: false`).
 */
export async function fetchContributions(login, { now = Date.now() } = {}) {
  const { data, errors } = await graphqlRequest(OVERVIEW_QUERY, overviewVariables(login, now));
  if (!data?.user && errors.length) {
    throw new Error(errors[0].message || 'Could not load contribution data.');
  }
  const overview = buildOverview(data, { login, now });

  const batches = chunk(overview.repos, REPOS_PER_REQUEST);
  const results = await Promise.allSettled(
    batches.map((batch) => {
      const { query, variables } = repoCountsQuery(login, batch.map((r) => r.nameWithOwner));
      return graphqlRequest(query, variables);
    })
  );

  let repos = [];
  results.forEach((result, i) => {
    const batch = batches[i];
    if (result.status === 'fulfilled') {
      repos.push(...applyRepoCounts(batch, result.value.data));
    } else {
      if (['rate_limited', 'unauthorized'].includes(result.reason?.kind)) throw result.reason;
      repos.push(...batch);
    }
  });

  return { ...overview, repos: sortRepos(repos, 'activity') };
}
