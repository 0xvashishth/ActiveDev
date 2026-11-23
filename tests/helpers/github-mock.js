/**
 * Fake GitHub API for tests: routes fetch() calls to handlers and records them.
 */
export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function installFetchMock(routes) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method || 'GET', body, headers: init.headers || {} });
    for (const [matcher, handler] of routes) {
      const matches = typeof matcher === 'function' ? matcher(url, init) : url.href.startsWith(matcher);
      if (matches) return handler(url, body, init);
    }
    throw new Error(`Unmocked fetch: ${init.method || 'GET'} ${url.href}`);
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

let counter = 1000;

/** REST search item as returned by /search/issues. */
export function searchItem({ owner, repo, number, title, author, draft = false, nodeId }) {
  const id = ++counter;
  return {
    id,
    node_id: nodeId || `PR_${owner}_${repo}_${number}`,
    number,
    title,
    html_url: `https://github.com/${owner}/${repo}/pull/${number}`,
    repository_url: `https://api.github.com/repos/${owner}/${repo}`,
    user: { login: author },
    draft,
    state: 'open',
    labels: [],
    comments: 0,
    created_at: '2024-05-01T10:00:00Z',
    updated_at: '2024-05-02T10:00:00Z',
    pull_request: { url: `https://api.github.com/repos/${owner}/${repo}/pulls/${number}` },
  };
}

export function review(id, login, state, submittedAt, commitOid = 'sha-old', body = '') {
  return {
    id,
    databaseId: Number(String(id).replace(/\D/g, '')) || 1,
    state,
    submittedAt,
    url: `https://github.com/x/y/pull/1#pullrequestreview-${id}`,
    body,
    author: { login },
    commit: { oid: commitOid },
  };
}

export function thread({ resolved = false, outdated = false, starter, last }) {
  return {
    isResolved: resolved,
    isOutdated: outdated,
    firstComment: { nodes: [{ author: { login: starter } }] },
    lastComment: { totalCount: 2, nodes: [{ author: { login: last || starter }, createdAt: '2024-05-02T00:00:00Z' }] },
  };
}

/** GraphQL PullRequest node matching PULL_REQUEST_FIELDS. */
export function prNode(item, overrides = {}) {
  const [owner, repo] = item.repository_url.split('/').slice(-2);
  return {
    id: item.node_id,
    databaseId: item.id + 500000,
    number: item.number,
    title: item.title,
    url: item.html_url,
    state: 'OPEN',
    isDraft: item.draft,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    additions: 10,
    deletions: 2,
    changedFiles: 3,
    mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED',
    headRefOid: 'sha-head',
    author: { login: item.user.login, avatarUrl: 'https://avatars/x' },
    repository: { name: repo, nameWithOwner: `${owner}/${repo}`, isPrivate: true, owner: { login: owner } },
    labels: { nodes: [] },
    comments: { totalCount: 0 },
    reviewRequests: { nodes: [] },
    reviews: { totalCount: 0, nodes: [] },
    viewerLatestReview: null,
    reviewThreads: { totalCount: 0, nodes: [] },
    commits: { totalCount: 1, nodes: [{ commit: { oid: 'sha-head', statusCheckRollup: { state: 'SUCCESS' } } }] },
    ...overrides,
  };
}
