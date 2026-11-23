import { GITHUB_API_BASE, GITHUB_GRAPHQL_URL, GRAPHQL_BATCH_SIZE, MAX_PRS } from './constants.js';
import { getAccessToken } from './auth.js';

/**
 * Error raised for any failed GitHub call. `kind` lets callers react precisely
 * (e.g. only log out on `unauthorized`) instead of string-matching messages.
 *   unauthorized | rate_limited | sso_required | oauth_restricted | forbidden |
 *   not_found | graphql | http | network
 */
export class GitHubApiError extends Error {
  constructor(message, { status = null, kind = 'http', resetAt = null, ssoUrl = null } = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.kind = kind;
    this.resetAt = resetAt;
    this.ssoUrl = ssoUrl;
  }
}

const OAUTH_RESTRICTED_RE = /OAuth App access restrictions/i;
const SSO_RE = /SAML|single sign-on|\bSSO\b/i;

/**
 * Parses GitHub's `X-GitHub-SSO` response header.
 *   "required; url=https://github.com/orgs/x/sso?authorization_request=..."
 *   "partial-results; organizations=21955855,20582480"
 */
export function parseSsoHeader(value) {
  if (!value) return null;
  const [kind, ...params] = value.split(';').map((s) => s.trim());
  const result = { kind, url: null, organizationIds: [] };
  for (const param of params) {
    const eq = param.indexOf('=');
    if (eq === -1) continue;
    const key = param.slice(0, eq).trim();
    const val = param.slice(eq + 1).trim();
    if (key === 'url') result.url = val;
    if (key === 'organizations') {
      result.organizationIds = val.split(',').map((id) => Number(id.trim())).filter(Number.isFinite);
    }
  }
  return result;
}

/** Classifies an error message coming from GitHub into an access-problem kind. */
export function classifyAccessMessage(message) {
  if (!message) return null;
  if (OAUTH_RESTRICTED_RE.test(message)) return 'oauth_restricted';
  if (SSO_RE.test(message)) return 'sso_required';
  return null;
}

async function request(url, { method = 'GET', body, headers = {} } = {}) {
  const token = await getAccessToken();
  if (!token) {
    throw new GitHubApiError('Not authenticated', { kind: 'unauthorized' });
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch (error) {
    throw new GitHubApiError(`Network error: ${error.message}`, { kind: 'network' });
  }

  if (response.ok) {
    return { data: await response.json(), headers: response.headers };
  }

  const errorBody = await response.json().catch(() => null);
  const message = errorBody?.message || response.statusText || 'Unknown error';

  if (response.status === 401) {
    throw new GitHubApiError('Token expired or revoked. Please log in again.', { status: 401, kind: 'unauthorized' });
  }

  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get('x-ratelimit-remaining');
    const retryAfter = response.headers.get('retry-after');
    if (remaining === '0' || retryAfter) {
      const resetAt = retryAfter
        ? Date.now() + Number(retryAfter) * 1000
        : Number(response.headers.get('x-ratelimit-reset')) * 1000 || Date.now() + 60_000;
      throw new GitHubApiError(
        `GitHub API rate limit exceeded. Resets at ${new Date(resetAt).toLocaleTimeString()}.`,
        { status: response.status, kind: 'rate_limited', resetAt }
      );
    }

    const sso = parseSsoHeader(response.headers.get('x-github-sso'));
    if (sso?.kind === 'required') {
      throw new GitHubApiError(message, { status: 403, kind: 'sso_required', ssoUrl: sso.url });
    }
    throw new GitHubApiError(message, {
      status: 403,
      kind: classifyAccessMessage(message) || 'forbidden',
    });
  }

  if (response.status === 404) {
    throw new GitHubApiError(message, { status: 404, kind: 'not_found' });
  }

  throw new GitHubApiError(`GitHub API error (${response.status}): ${message}`, { status: response.status });
}

async function restRequest(endpoint) {
  return request(`${GITHUB_API_BASE}${endpoint}`);
}

/**
 * Runs a GraphQL query. Partial failures are normal on GitHub (e.g. one PR in
 * an org that restricts OAuth apps), so `errors` is returned next to `data`
 * rather than thrown, unless nothing at all came back.
 */
export async function graphqlRequest(query, variables = {}) {
  const { data: body } = await request(GITHUB_GRAPHQL_URL, { method: 'POST', body: { query, variables } });
  const errors = Array.isArray(body?.errors) ? body.errors : [];

  if (!body?.data) {
    const first = errors[0];
    if (first?.type === 'RATE_LIMITED') {
      throw new GitHubApiError('GitHub GraphQL rate limit exceeded.', {
        kind: 'rate_limited',
        resetAt: Date.now() + 60_000,
      });
    }
    throw new GitHubApiError(`GitHub GraphQL error: ${first?.message || 'no data returned'}`, {
      kind: classifyAccessMessage(first?.message) || 'graphql',
    });
  }
  return { data: body.data, errors };
}

// ---------------------------------------------------------------------------
// User / token
// ---------------------------------------------------------------------------

/** Returns the authenticated user and the scopes granted to the token (one request). */
export async function getViewer() {
  const { data, headers } = await restRequest('/user');
  const scopesHeader = headers.get('x-oauth-scopes');
  return {
    user: data,
    scopes: scopesHeader == null ? null : scopesHeader.split(',').map((s) => s.trim()).filter(Boolean),
  };
}

export async function getCurrentUser() {
  return (await getViewer()).user;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Searches open pull requests. When some organizations hide results because
 * the token is not SAML-authorized, GitHub still answers 200 but adds an
 * `X-GitHub-SSO: partial-results; organizations=…` header; we surface that.
 */
export async function searchPullRequests(query, max = MAX_PRS) {
  const perPage = Math.min(Math.max(max, 1), 100);
  const params = new URLSearchParams({ q: query, per_page: String(perPage), sort: 'updated', order: 'desc' });
  const { data, headers } = await restRequest(`/search/issues?${params}`);
  const sso = parseSsoHeader(headers.get('x-github-sso'));

  return {
    items: Array.isArray(data?.items) ? data.items.filter((item) => item.pull_request) : [],
    totalCount: data?.total_count ?? 0,
    incompleteResults: !!data?.incomplete_results,
    ssoOrganizationIds: sso?.kind === 'partial-results' ? sso.organizationIds : [],
  };
}

export function reviewRequestsQuery(login) {
  return `is:pr is:open archived:false review-requested:${login}`;
}

export function authoredPRsQuery(login) {
  return `is:pr is:open archived:false author:${login}`;
}

// ---------------------------------------------------------------------------
// Pull request details (GraphQL)
// ---------------------------------------------------------------------------

export const PULL_REQUEST_FIELDS = `
  id
  databaseId
  number
  title
  url
  state
  isDraft
  createdAt
  updatedAt
  additions
  deletions
  changedFiles
  mergeable
  reviewDecision
  headRefOid
  author { login avatarUrl }
  repository { name nameWithOwner isPrivate owner { login } }
  labels(first: 10) { nodes { name color } }
  comments { totalCount }
  reviewRequests(first: 30) {
    nodes {
      requestedReviewer {
        __typename
        ... on User { login }
        ... on Team { slug name organization { login } }
      }
    }
  }
  reviews(last: 100) {
    totalCount
    nodes {
      id
      databaseId
      state
      submittedAt
      url
      body
      author { login }
      commit { oid }
    }
  }
  viewerLatestReview { state submittedAt commit { oid } }
  reviewThreads(first: 100) {
    totalCount
    nodes {
      isResolved
      isOutdated
      firstComment: comments(first: 1) { nodes { author { login } } }
      lastComment: comments(last: 1) { totalCount nodes { author { login } createdAt } }
    }
  }
  commits(last: 1) {
    totalCount
    nodes { commit { oid statusCheckRollup { state } } }
  }
`;

const PULL_REQUEST_DETAILS_QUERY = `
  query PullRequestDetails($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on PullRequest {
        ${PULL_REQUEST_FIELDS}
      }
    }
  }
`;

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Fetches rich details for many PRs using as few requests as possible.
 * Returns a Map(nodeId -> GraphQL PullRequest) plus per-PR errors. A failing
 * batch does not fail the others.
 */
export async function fetchPullRequestDetails(nodeIds) {
  const unique = [...new Set(nodeIds.filter(Boolean))];
  const details = new Map();
  const errors = [];

  const batches = chunk(unique, GRAPHQL_BATCH_SIZE);
  const results = await Promise.allSettled(
    batches.map((ids) => graphqlRequest(PULL_REQUEST_DETAILS_QUERY, { ids }))
  );

  results.forEach((result, batchIndex) => {
    if (result.status === 'rejected') {
      // Rate limiting / auth problems must bubble up; others degrade gracefully.
      if (['rate_limited', 'unauthorized'].includes(result.reason?.kind)) throw result.reason;
      errors.push({ ids: batches[batchIndex], message: result.reason?.message || String(result.reason) });
      return;
    }
    const { data, errors: gqlErrors } = result.value;
    for (const node of data.nodes || []) {
      if (node?.id) details.set(node.id, node);
    }
    for (const err of gqlErrors) {
      errors.push({ message: err.message, type: err.type, path: err.path, kind: classifyAccessMessage(err.message) });
    }
  });

  return { details, errors };
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

async function listAll(endpoint, maxPages = 5) {
  const items = [];
  const sep = endpoint.includes('?') ? '&' : '?';
  for (let page = 1; page <= maxPages; page++) {
    const { data } = await restRequest(`${endpoint}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    items.push(...data);
    if (data.length < 100) break;
  }
  return items;
}

/**
 * All organizations the user belongs to. GitHub's `/user/orgs` only lists orgs
 * the token is allowed to operate on, so orgs that restrict OAuth apps can be
 * missing from it. We therefore merge three sources (any may fail):
 *   - /user/orgs                 (orgs this authorization can act on)
 *   - /user/memberships/orgs     (active memberships, needs read:org)
 *   - /users/{login}/orgs        (public memberships, always visible)
 */
export async function getUserOrganizations(login) {
  const sources = [
    listAll('/user/orgs'),
    listAll('/user/memberships/orgs?state=active').then((memberships) =>
      memberships.map((m) => m.organization).filter(Boolean)
    ),
    login ? listAll(`/users/${encodeURIComponent(login)}/orgs`) : Promise.resolve([]),
  ];

  const results = await Promise.allSettled(sources);
  const byLogin = new Map();
  let anySucceeded = false;
  for (const result of results) {
    if (result.status === 'rejected') {
      if (['rate_limited', 'unauthorized'].includes(result.reason?.kind)) throw result.reason;
      continue;
    }
    anySucceeded = true;
    for (const org of result.value) {
      if (org?.login && !byLogin.has(org.login.toLowerCase())) {
        byLogin.set(org.login.toLowerCase(), { id: org.id, login: org.login, avatarUrl: org.avatar_url || null });
      }
    }
  }
  if (!anySucceeded) {
    throw results[0].reason;
  }
  return [...byLogin.values()].sort((a, b) => a.login.localeCompare(b.login));
}

/**
 * Probes each organization for the two common reasons an OAuth token cannot
 * see its pull requests: OAuth App access restrictions and SAML SSO.
 * Returns Map(login -> { access: 'ok' | 'oauth_restricted' | 'sso_required' | 'error', message }).
 */
export async function checkOrganizationAccess(logins) {
  const results = new Map();

  for (const batch of chunk(logins, 20)) {
    const varDefs = batch.map((_, i) => `$o${i}: String!`).join(', ');
    const fields = batch
      .map(
        (_, i) => `o${i}: organization(login: $o${i}) {
          login
          viewerIsAMember
          teams(first: 1) { totalCount }
          repositories(first: 1) { totalCount }
        }`
      )
      .join('\n');
    const variables = Object.fromEntries(batch.map((login, i) => [`o${i}`, login]));

    let data = {};
    let errors = [];
    try {
      ({ data, errors } = await graphqlRequest(`query OrgAccess(${varDefs}) { ${fields} }`, variables));
    } catch (error) {
      if (['rate_limited', 'unauthorized'].includes(error.kind)) throw error;
      const kind = classifyAccessMessage(error.message);
      batch.forEach((login) => results.set(login, { access: kind || 'error', message: error.message }));
      continue;
    }

    batch.forEach((login, i) => {
      const alias = `o${i}`;
      const orgErrors = errors.filter((err) => Array.isArray(err.path) && err.path[0] === alias);
      if (orgErrors.length > 0) {
        const kinds = orgErrors.map((err) => classifyAccessMessage(err.message)).filter(Boolean);
        results.set(login, {
          access: kinds[0] || 'error',
          message: orgErrors[0].message,
        });
      } else if (!data?.[alias]) {
        results.set(login, { access: 'error', message: 'Organization not accessible' });
      } else {
        results.set(login, { access: 'ok', message: null });
      }
    });
  }

  return results;
}
