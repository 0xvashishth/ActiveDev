import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installChromeMock } from './helpers/chrome-mock.js';
import { installFetchMock, jsonResponse } from './helpers/github-mock.js';
import { STORAGE_KEYS } from '../lib/constants.js';
import {
  checkOrganizationAccess,
  classifyAccessMessage,
  fetchPullRequestDetails,
  getUserOrganizations,
  getViewer,
  graphqlRequest,
  parseSsoHeader,
  searchPullRequests,
} from '../lib/github-api.js';

const RESTRICTED_MSG =
  'Although you appear to have the correct authorization credentials, the `locked` organization has enabled OAuth App access restrictions, meaning that data access to third-parties is limited.';
const SAML_MSG = 'Resource protected by organization SAML enforcement. You must grant your OAuth token access to this organization.';

let fetchMock;
beforeEach(async () => {
  installChromeMock();
  await chrome.storage.local.set({ [STORAGE_KEYS.ACCESS_TOKEN]: 'tok' });
});
afterEach(() => fetchMock?.restore());

test('parseSsoHeader parses partial-results and required forms', () => {
  assert.deepEqual(parseSsoHeader('partial-results; organizations=21955855,20582480'), {
    kind: 'partial-results',
    url: null,
    organizationIds: [21955855, 20582480],
  });
  assert.equal(parseSsoHeader('required; url=https://github.com/orgs/x/sso?a=1').url, 'https://github.com/orgs/x/sso?a=1');
  assert.equal(parseSsoHeader(null), null);
});

test('classifyAccessMessage recognises OAuth restriction and SAML errors', () => {
  assert.equal(classifyAccessMessage(RESTRICTED_MSG), 'oauth_restricted');
  assert.equal(classifyAccessMessage(SAML_MSG), 'sso_required');
  assert.equal(classifyAccessMessage('Not Found'), null);
});

test('getViewer returns user and token scopes from one request', async () => {
  fetchMock = installFetchMock([
    ['https://api.github.com/user', () => jsonResponse({ login: 'me' }, { headers: { 'x-oauth-scopes': 'repo, read:org, read:user' } })],
  ]);
  const { user, scopes } = await getViewer();
  assert.equal(user.login, 'me');
  assert.deepEqual(scopes, ['repo', 'read:org', 'read:user']);
  assert.equal(fetchMock.calls[0].headers.Authorization, 'Bearer tok');
});

test('searchPullRequests reports orgs hidden by SAML SSO', async () => {
  fetchMock = installFetchMock([
    [
      'https://api.github.com/search/issues',
      (url) => {
        assert.equal(url.searchParams.get('q'), 'is:pr is:open review-requested:me');
        return jsonResponse(
          { total_count: 1, incomplete_results: false, items: [{ id: 1, pull_request: {} }, { id: 2 }] },
          { headers: { 'x-github-sso': 'partial-results; organizations=42' } }
        );
      },
    ],
  ]);
  const result = await searchPullRequests('is:pr is:open review-requested:me');
  assert.equal(result.items.length, 1, 'non-PR issues are filtered out');
  assert.deepEqual(result.ssoOrganizationIds, [42]);
});

test('errors are typed: 401 → unauthorized, exhausted quota → rate_limited, restriction → oauth_restricted', async () => {
  const responses = [
    jsonResponse({ message: 'Bad credentials' }, { status: 401 }),
    jsonResponse({ message: 'API rate limit exceeded' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' } }),
    jsonResponse({ message: RESTRICTED_MSG }, { status: 403 }),
    jsonResponse({ message: 'SSO' }, { status: 403, headers: { 'x-github-sso': 'required; url=https://github.com/orgs/a/sso' } }),
  ];
  fetchMock = installFetchMock([['https://api.github.com/user', () => responses.shift()]]);

  await assert.rejects(getViewer(), { kind: 'unauthorized', status: 401 });
  await assert.rejects(getViewer(), (e) => e.kind === 'rate_limited' && e.resetAt === 2000000000 * 1000);
  await assert.rejects(getViewer(), { kind: 'oauth_restricted' });
  await assert.rejects(getViewer(), { kind: 'sso_required', ssoUrl: 'https://github.com/orgs/a/sso' });
});

test('fetchPullRequestDetails batches ids and tolerates partial GraphQL errors', async () => {
  const ids = Array.from({ length: 25 }, (_, i) => `PR_${i}`);
  fetchMock = installFetchMock([
    [
      'https://api.github.com/graphql',
      (url, body) =>
        jsonResponse({
          data: { nodes: body.variables.ids.map((id) => (id === 'PR_3' ? null : { id, number: 1 })) },
          errors: body.variables.ids.includes('PR_3') ? [{ type: 'FORBIDDEN', message: RESTRICTED_MSG, path: ['nodes', 3] }] : undefined,
        }),
    ],
  ]);

  const { details, errors } = await fetchPullRequestDetails([...ids, 'PR_0', null]);
  assert.equal(fetchMock.calls.length, 2, '25 unique ids → 2 batches of ≤20');
  assert.equal(details.size, 24);
  assert.equal(details.has('PR_3'), false);
  assert.equal(errors[0].kind, 'oauth_restricted');
});

test('fetchPullRequestDetails propagates rate limiting', async () => {
  fetchMock = installFetchMock([
    ['https://api.github.com/graphql', () => jsonResponse({ message: 'limit' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' } })],
  ]);
  await assert.rejects(fetchPullRequestDetails(['a']), { kind: 'rate_limited' });
});

test('getUserOrganizations merges sources and survives one failing', async () => {
  fetchMock = installFetchMock([
    ['https://api.github.com/user/orgs', () => jsonResponse([{ id: 1, login: 'acme', avatar_url: 'a' }])],
    ['https://api.github.com/user/memberships/orgs', () => jsonResponse({ message: 'Forbidden' }, { status: 403 })],
    ['https://api.github.com/users/me/orgs', () => jsonResponse([{ id: 2, login: 'locked' }, { id: 1, login: 'ACME' }])],
  ]);
  const orgs = await getUserOrganizations('me');
  assert.deepEqual(orgs.map((o) => o.login), ['acme', 'locked']);
});

test('checkOrganizationAccess classifies each org from GraphQL errors', async () => {
  fetchMock = installFetchMock([
    [
      'https://api.github.com/graphql',
      (url, body) => {
        assert.deepEqual(body.variables, { o0: 'acme', o1: 'locked', o2: 'samlco', o3: 'gone' });
        return jsonResponse({
          data: { o0: { login: 'acme' }, o1: { login: 'locked', teams: null }, o2: null, o3: null },
          errors: [
            { type: 'FORBIDDEN', path: ['o1', 'teams'], message: RESTRICTED_MSG },
            { type: 'FORBIDDEN', path: ['o2'], message: SAML_MSG },
            { type: 'NOT_FOUND', path: ['o3'], message: 'Could not resolve to an Organization' },
          ],
        });
      },
    ],
  ]);
  const result = await checkOrganizationAccess(['acme', 'locked', 'samlco', 'gone']);
  assert.equal(result.get('acme').access, 'ok');
  assert.equal(result.get('locked').access, 'oauth_restricted');
  assert.equal(result.get('samlco').access, 'sso_required');
  assert.equal(result.get('gone').access, 'error');
});

test('checkOrganizationAccess treats missing data with no accompanying error as inaccessible', async () => {
  fetchMock = installFetchMock([['https://api.github.com/graphql', () => jsonResponse({ data: {} })]]);
  const result = await checkOrganizationAccess(['vanished']);
  assert.deepEqual(result.get('vanished'), { access: 'error', message: 'Organization not accessible' });
});

test('request(): no token means unauthorized, a plain 404 is not_found, and other statuses carry the status code', async () => {
  await chrome.storage.local.remove(STORAGE_KEYS.ACCESS_TOKEN);
  await assert.rejects(getViewer(), { kind: 'unauthorized' });
  await chrome.storage.local.set({ [STORAGE_KEYS.ACCESS_TOKEN]: 'tok' });

  fetchMock = installFetchMock([['https://api.github.com/user', () => jsonResponse({ message: 'Not Found' }, { status: 404 })]]);
  await assert.rejects(getViewer(), { kind: 'not_found', status: 404 });

  fetchMock = installFetchMock([['https://api.github.com/user', () => jsonResponse({ message: 'teapot' }, { status: 418 })]]);
  await assert.rejects(getViewer(), { status: 418, message: /GitHub API error \(418\): teapot/ });
});

test('graphqlRequest throws a typed error when no data comes back at all (rate-limited or otherwise)', async () => {
  fetchMock = installFetchMock([
    ['https://api.github.com/graphql', () => jsonResponse({ errors: [{ type: 'RATE_LIMITED', message: 'slow down' }] })],
  ]);
  await assert.rejects(graphqlRequest('query {}'), { kind: 'rate_limited' });

  fetchMock = installFetchMock([['https://api.github.com/graphql', () => jsonResponse({ errors: [{ message: RESTRICTED_MSG }] })]]);
  await assert.rejects(graphqlRequest('query {}'), { kind: 'oauth_restricted' });

  fetchMock = installFetchMock([['https://api.github.com/graphql', () => jsonResponse({})]]);
  await assert.rejects(graphqlRequest('query {}'), { kind: 'graphql', message: /no data returned/ });
});
