import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeReviews,
  analyzeThreads,
  analyzeReviewRequests,
  buildPullRequestModel,
  ciStateFromRollup,
  describeReviewState,
  findNewReviewRequests,
  findNewReviewsOnMyPRs,
  parseRepoUrl,
} from '../lib/pr-model.js';
import { prNode, review, searchItem, thread } from './helpers/github-mock.js';

test('parseRepoUrl handles org repos and bad input', () => {
  assert.deepEqual(parseRepoUrl('https://api.github.com/repos/acme/web'), { owner: 'acme', repo: 'web' });
  assert.deepEqual(parseRepoUrl(undefined), { owner: null, repo: null });
});

test('analyzeReviews keeps approvals when a reviewer later only comments', () => {
  const result = analyzeReviews(
    [
      review('R1', 'alice', 'APPROVED', '2024-05-01T00:00:00Z'),
      review('R2', 'alice', 'COMMENTED', '2024-05-02T00:00:00Z'),
      review('R3', 'bob', 'CHANGES_REQUESTED', '2024-05-01T00:00:00Z'),
      review('R4', 'bob', 'APPROVED', '2024-05-03T00:00:00Z'),
      review('R5', 'carol', 'COMMENTED', '2024-05-01T00:00:00Z'),
    ],
    { prAuthor: 'author' }
  );
  assert.deepEqual(result.approvals.sort(), ['alice', 'bob']);
  assert.deepEqual(result.changesRequested, []);
  assert.deepEqual(result.commenters, ['carol']);
  assert.equal(result.reviewState, 'approved');
});

test('analyzeReviews ignores pending reviews and the PR author, honours dismissals', () => {
  const result = analyzeReviews(
    [
      review('R1', 'author', 'COMMENTED', '2024-05-01T00:00:00Z'),
      review('R2', 'me', 'PENDING', null),
      review('R3', 'dave', 'DISMISSED', '2024-05-01T00:00:00Z'),
      review('R4', 'erin', 'CHANGES_REQUESTED', '2024-05-01T00:00:00Z'),
    ],
    { prAuthor: 'Author', viewerLogin: 'me' }
  );
  assert.deepEqual(result.reviewers.map((r) => r.login).sort(), ['dave', 'erin']);
  assert.equal(result.reviewers.find((r) => r.login === 'dave').state, 'COMMENTED');
  assert.equal(result.reviewState, 'changes_requested');
});

test('analyzeThreads counts resolved / unresolved and who owes a reply', () => {
  const stats = analyzeThreads(
    {
      totalCount: 5,
      nodes: [
        thread({ resolved: true, starter: 'alice' }),
        thread({ starter: 'alice', last: 'alice' }), // awaiting me
        thread({ starter: 'alice', last: 'me' }), // I replied
        thread({ starter: 'me', last: 'bob', outdated: true }), // started by me, awaiting me
        thread({ resolved: true, starter: 'me' }),
      ],
    },
    { viewerLogin: 'me' }
  );
  assert.deepEqual(stats, {
    total: 5,
    resolved: 2,
    unresolved: 3,
    outdated: 1,
    awaitingViewer: 2,
    startedByViewer: 1,
    truncated: false,
  });
});

test('analyzeThreads flags truncation when more threads exist than fetched', () => {
  assert.equal(analyzeThreads({ totalCount: 150, nodes: [thread({ starter: 'a' })] }).truncated, true);
});

test('analyzeReviewRequests distinguishes direct vs team requests', () => {
  const team = { requestedReviewer: { __typename: 'Team', slug: 'backend', name: 'Backend', organization: { login: 'acme' } } };
  const me = { requestedReviewer: { __typename: 'User', login: 'Me' } };
  const other = { requestedReviewer: { __typename: 'User', login: 'zed' } };

  const viaTeam = analyzeReviewRequests({ nodes: [team, other] }, { viewerLogin: 'me' });
  assert.equal(viaTeam.viewerRequestVia, 'team');
  assert.deepEqual(viaTeam.requestedTeams, ['acme/backend']);

  const direct = analyzeReviewRequests({ nodes: [team, me] }, { viewerLogin: 'me' });
  assert.equal(direct.viewerRequestVia, 'direct');
});

test('ciStateFromRollup maps all rollup states', () => {
  assert.equal(ciStateFromRollup('SUCCESS'), 'passing');
  assert.equal(ciStateFromRollup('FAILURE'), 'failing');
  assert.equal(ciStateFromRollup('ERROR'), 'failing');
  assert.equal(ciStateFromRollup('PENDING'), 'pending');
  assert.equal(ciStateFromRollup('EXPECTED'), 'pending');
  assert.equal(ciStateFromRollup(undefined), 'unknown');
});

test('buildPullRequestModel: review request already reviewed by others, re-requested, new commits', () => {
  const item = searchItem({ owner: 'acme', repo: 'api', number: 7, title: 'Add cache', author: 'alice' });
  const node = prNode(item, {
    mergeable: 'CONFLICTING',
    reviewRequests: {
      nodes: [{ requestedReviewer: { __typename: 'User', login: 'me' } }],
    },
    reviews: {
      totalCount: 3,
      nodes: [
        review('R1', 'me', 'CHANGES_REQUESTED', '2024-05-01T00:00:00Z', 'sha-old'),
        review('R2', 'bob', 'APPROVED', '2024-05-02T00:00:00Z', 'sha-head'),
        review('R3', 'me', 'PENDING', null),
      ],
    },
    viewerLatestReview: { state: 'CHANGES_REQUESTED', submittedAt: '2024-05-01T00:00:00Z', commit: { oid: 'sha-old' } },
    reviewThreads: {
      totalCount: 2,
      nodes: [thread({ starter: 'me', last: 'alice' }), thread({ resolved: true, starter: 'bob' })],
    },
    commits: { totalCount: 4, nodes: [{ commit: { oid: 'sha-head', statusCheckRollup: { state: 'FAILURE' } } }] },
  });

  const pr = buildPullRequestModel(item, node, { viewerLogin: 'me' });

  assert.equal(pr.id, item.id, 'keeps the REST id so ids are stable across polls');
  assert.equal(pr.detailsAvailable, true);
  assert.equal(pr.owner, 'acme');
  assert.equal(pr.viewerRequestVia, 'direct');
  assert.deepEqual(pr.otherReviewers.map((r) => [r.login, r.state]), [['bob', 'APPROVED']]);
  assert.equal(pr.viewerReview.state, 'CHANGES_REQUESTED');
  assert.equal(pr.newCommitsSinceViewerReview, true);
  assert.equal(pr.viewerHasPendingReview, true);
  assert.equal(pr.threads.unresolved, 1);
  assert.equal(pr.threads.resolved, 1);
  assert.equal(pr.threads.startedByViewer, 1);
  assert.equal(pr.ciState, 'failing');
  assert.equal(pr.mergeable, 'CONFLICTING');
  assert.equal(pr.recentReviews.length, 2, 'pending reviews are not tracked');
});

test('buildPullRequestModel falls back to search data when details are missing', () => {
  const item = searchItem({ owner: 'locked-org', repo: 'x', number: 1, title: 'T', author: 'a' });
  const pr = buildPullRequestModel(item, undefined, { viewerLogin: 'me', detailsError: 'restricted' });
  assert.equal(pr.detailsAvailable, false);
  assert.equal(pr.detailsError, 'restricted');
  assert.equal(pr.owner, 'locked-org');
  assert.deepEqual(pr.otherReviewers, []);
  assert.equal(pr.threads.total, 0);
});

test('findNewReviewRequests returns only PRs that were not present before', () => {
  const prev = [{ id: 1 }, { id: 2 }];
  const curr = [{ id: 2 }, { id: 3 }];
  assert.deepEqual(findNewReviewRequests(prev, curr), [{ id: 3 }]);
});

test('describeReviewState covers every review state', () => {
  assert.equal(describeReviewState('APPROVED'), 'approved');
  assert.equal(describeReviewState('CHANGES_REQUESTED'), 'requested changes on');
  assert.equal(describeReviewState('DISMISSED'), 'had a review dismissed on');
  assert.equal(describeReviewState('COMMENTED'), 'commented on');
  assert.equal(describeReviewState('something-else'), 'commented on');
});

test('findNewReviewsOnMyPRs skips seen reviews and my own replies', () => {
  const prs = [
    {
      author: 'me',
      recentReviews: [
        { id: 'A', author: 'bob', state: 'APPROVED' },
        { id: 'B', author: 'me', state: 'COMMENTED' },
        { id: 'C', author: 'carol', state: 'CHANGES_REQUESTED' },
      ],
    },
  ];
  const { fresh, seen } = findNewReviewsOnMyPRs(prs, ['A'], { viewerLogin: 'me' });
  assert.deepEqual(fresh.map((f) => f.review.id), ['C']);
  assert.deepEqual([...seen].sort(), ['A', 'B', 'C']);
});
