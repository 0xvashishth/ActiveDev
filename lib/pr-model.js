/**
 * Pure functions that turn raw GitHub data into the compact PR model stored
 * by the extension and rendered by the popup. No chrome.* or network access,
 * so everything here is unit-testable in Node.
 */

const sameLogin = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function parseRepoUrl(repositoryUrl) {
  if (!repositoryUrl || typeof repositoryUrl !== 'string') return { owner: null, repo: null };
  const parts = repositoryUrl.replace(/\/+$/, '').split('/');
  return { owner: parts[parts.length - 2] || null, repo: parts[parts.length - 1] || null };
}

/** Maps GitHub's combined status/check rollup to the popup's CI states. */
export function ciStateFromRollup(state) {
  switch (state) {
    case 'SUCCESS':
      return 'passing';
    case 'FAILURE':
    case 'ERROR':
      return 'failing';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'unknown';
  }
}

/**
 * Per-reviewer verdict, following GitHub semantics: a later plain comment does
 * not cancel an earlier approval / change request, but a dismissal does.
 * Pending (unsubmitted) reviews are ignored.
 */
export function analyzeReviews(reviews, { prAuthor, viewerLogin } = {}) {
  const byUser = new Map();
  const sorted = [...(reviews || [])]
    .filter((r) => r && r.state && r.state !== 'PENDING' && r.author?.login)
    .sort((a, b) => new Date(a.submittedAt || 0) - new Date(b.submittedAt || 0));

  for (const review of sorted) {
    const login = review.author.login;
    if (sameLogin(login, prAuthor)) continue; // author replying to threads is not a review
    const entry = byUser.get(login) || { login, state: 'COMMENTED', submittedAt: null, commitOid: null };
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
      entry.state = review.state === 'DISMISSED' ? 'COMMENTED' : review.state;
    }
    entry.submittedAt = review.submittedAt;
    entry.commitOid = review.commit?.oid || entry.commitOid;
    byUser.set(login, entry);
  }

  const reviewers = [...byUser.values()].map((r) => ({
    login: r.login,
    state: r.state,
    submittedAt: r.submittedAt,
    isViewer: sameLogin(r.login, viewerLogin),
  }));

  const approvals = reviewers.filter((r) => r.state === 'APPROVED').map((r) => r.login);
  const changesRequested = reviewers.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.login);
  const commenters = reviewers.filter((r) => r.state === 'COMMENTED').map((r) => r.login);

  let reviewState = 'pending';
  if (changesRequested.length > 0) reviewState = 'changes_requested';
  else if (approvals.length > 0) reviewState = 'approved';
  else if (commenters.length > 0) reviewState = 'commented';

  return { reviewers, approvals, changesRequested, commenters, reviewState };
}

/**
 * Conversation (review thread) statistics.
 * - awaitingViewer: unresolved threads whose latest comment is by someone else
 *   (i.e. the ball is in the viewer's court).
 * - startedByViewer: unresolved threads the viewer opened (reviewer's view:
 *   "my feedback not yet addressed").
 */
export function analyzeThreads(reviewThreads, { viewerLogin } = {}) {
  const nodes = reviewThreads?.nodes || [];
  const stats = {
    total: reviewThreads?.totalCount ?? nodes.length,
    resolved: 0,
    unresolved: 0,
    outdated: 0,
    awaitingViewer: 0,
    startedByViewer: 0,
    truncated: (reviewThreads?.totalCount ?? nodes.length) > nodes.length,
  };

  for (const thread of nodes) {
    if (!thread) continue;
    if (thread.isResolved) {
      stats.resolved++;
      continue;
    }
    stats.unresolved++;
    if (thread.isOutdated) stats.outdated++;
    const starter = thread.firstComment?.nodes?.[0]?.author?.login;
    const lastAuthor = thread.lastComment?.nodes?.[0]?.author?.login;
    if (sameLogin(starter, viewerLogin)) stats.startedByViewer++;
    if (lastAuthor && !sameLogin(lastAuthor, viewerLogin)) stats.awaitingViewer++;
  }

  return stats;
}

export function analyzeReviewRequests(reviewRequests, { viewerLogin } = {}) {
  const requested = [];
  for (const node of reviewRequests?.nodes || []) {
    const reviewer = node?.requestedReviewer;
    if (!reviewer) continue;
    if (reviewer.__typename === 'Team') {
      const org = reviewer.organization?.login;
      requested.push({
        type: 'team',
        name: reviewer.name || reviewer.slug,
        slug: org ? `${org}/${reviewer.slug}` : reviewer.slug,
      });
    } else if (reviewer.login) {
      requested.push({ type: 'user', login: reviewer.login, isViewer: sameLogin(reviewer.login, viewerLogin) });
    }
  }

  const viewerRequestedDirectly = requested.some((r) => r.type === 'user' && r.isViewer);
  const teams = requested.filter((r) => r.type === 'team');
  return {
    requestedReviewers: requested,
    // For PRs found via `review-requested:<me>`: if I'm not requested directly,
    // the request came through one of my teams.
    viewerRequestVia: viewerRequestedDirectly ? 'direct' : teams.length > 0 ? 'team' : null,
    requestedTeams: teams.map((t) => t.slug),
  };
}

/** Minimal model built from a REST search item; used when GraphQL details are unavailable. */
export function baseModelFromSearchItem(item) {
  const { owner, repo } = parseRepoUrl(item.repository_url);
  return {
    id: item.id,
    nodeId: item.node_id || null,
    number: item.number,
    title: item.title || 'Untitled',
    htmlUrl: item.html_url,
    owner,
    repo,
    author: item.user?.login || null,
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    draft: !!item.draft,
    labels: (item.labels || []).map((l) => ({ name: l.name, color: l.color })).slice(0, 10),
    commentCount: item.comments ?? 0,
    detailsAvailable: false,
    detailsError: null,

    isPrivate: null,
    additions: null,
    deletions: null,
    changedFiles: null,
    mergeable: 'UNKNOWN',
    reviewDecision: null,
    ciState: 'unknown',
    reviewers: [],
    approvals: [],
    changesRequested: [],
    commenters: [],
    reviewState: 'pending',
    otherReviewers: [],
    requestedReviewers: [],
    viewerRequestVia: null,
    requestedTeams: [],
    viewerReview: null,
    viewerHasPendingReview: false,
    newCommitsSinceViewerReview: false,
    threads: { total: 0, resolved: 0, unresolved: 0, outdated: 0, awaitingViewer: 0, startedByViewer: 0, truncated: false },
    recentReviews: [],
  };
}

/**
 * Combines a REST search item with its GraphQL details into the stored model.
 * `detail` may be missing (inaccessible / failed), in which case the base
 * model is returned with `detailsAvailable: false`.
 */
export function buildPullRequestModel(item, detail, { viewerLogin, detailsError = null } = {}) {
  const base = baseModelFromSearchItem(item);
  if (!detail) return { ...base, detailsError };

  const author = detail.author?.login || base.author;
  const reviewNodes = detail.reviews?.nodes || [];
  const reviewAnalysis = analyzeReviews(reviewNodes, { prAuthor: author, viewerLogin });
  const requestAnalysis = analyzeReviewRequests(detail.reviewRequests, { viewerLogin });
  const lastCommit = detail.commits?.nodes?.[0]?.commit;
  const headOid = detail.headRefOid || lastCommit?.oid || null;

  const viewerLatest = detail.viewerLatestReview && detail.viewerLatestReview.state !== 'PENDING'
    ? detail.viewerLatestReview
    : null;
  const viewerReview = viewerLatest
    ? { state: viewerLatest.state, submittedAt: viewerLatest.submittedAt, commitOid: viewerLatest.commit?.oid || null }
    : (() => {
      const mine = reviewAnalysis.reviewers.find((r) => r.isViewer);
      return mine ? { state: mine.state, submittedAt: mine.submittedAt, commitOid: null } : null;
    })();

  const viewerHasPendingReview = reviewNodes.some(
    (r) => r?.state === 'PENDING' && sameLogin(r.author?.login, viewerLogin)
  );

  return {
    ...base,
    // Keep the REST search id: it must stay stable whether or not details load.
    id: base.id,
    nodeId: detail.id,
    number: detail.number ?? base.number,
    title: detail.title ?? base.title,
    htmlUrl: detail.url ?? base.htmlUrl,
    owner: detail.repository?.owner?.login ?? base.owner,
    repo: detail.repository?.name ?? base.repo,
    isPrivate: detail.repository?.isPrivate ?? null,
    author,
    authorAvatar: detail.author?.avatarUrl || null,
    createdAt: detail.createdAt ?? base.createdAt,
    updatedAt: detail.updatedAt ?? base.updatedAt,
    draft: !!detail.isDraft,
    labels: (detail.labels?.nodes || []).map((l) => ({ name: l.name, color: l.color })),
    additions: detail.additions ?? null,
    deletions: detail.deletions ?? null,
    changedFiles: detail.changedFiles ?? null,
    mergeable: detail.mergeable || 'UNKNOWN',
    reviewDecision: detail.reviewDecision || null,
    ciState: ciStateFromRollup(lastCommit?.statusCheckRollup?.state),
    commentCount: detail.comments?.totalCount ?? base.commentCount,
    detailsAvailable: true,
    detailsError: null,

    ...reviewAnalysis,
    otherReviewers: reviewAnalysis.reviewers.filter((r) => !r.isViewer),
    ...requestAnalysis,
    viewerReview,
    viewerHasPendingReview,
    newCommitsSinceViewerReview: !!(viewerReview?.commitOid && headOid && viewerReview.commitOid !== headOid),
    threads: analyzeThreads(detail.reviewThreads, { viewerLogin }),
    // Kept small: only what notifications need.
    recentReviews: reviewNodes
      .filter((r) => r && r.state !== 'PENDING')
      .slice(-30)
      .map((r) => ({
        id: r.id,
        author: r.author?.login || 'someone',
        state: r.state,
        submittedAt: r.submittedAt,
        url: r.url || null,
        bodySnippet: (r.body || '').replace(/\s+/g, ' ').trim().slice(0, 140),
      })),
  };
}

/** Review requests the viewer has not seen in the previous poll. */
export function findNewReviewRequests(previous, current) {
  const previousIds = new Set((previous || []).map((pr) => pr.id));
  return (current || []).filter((pr) => !previousIds.has(pr.id));
}

/**
 * Reviews on the viewer's own PRs that have not been notified yet.
 * Returns the new reviews and the updated set of seen review ids.
 */
export function findNewReviewsOnMyPRs(myPRs, seenIds, { viewerLogin } = {}) {
  const seen = new Set(seenIds || []);
  const fresh = [];
  for (const pr of myPRs || []) {
    for (const review of pr.recentReviews || []) {
      if (!review.id || seen.has(review.id)) continue;
      seen.add(review.id);
      if (sameLogin(review.author, viewerLogin) || sameLogin(review.author, pr.author)) continue;
      fresh.push({ pr, review });
    }
  }
  return { fresh, seen };
}

/** Short human summary used by notifications and tooltips. */
export function describeReviewState(state) {
  switch (state) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'requested changes on';
    case 'DISMISSED':
      return 'had a review dismissed on';
    default:
      return 'commented on';
  }
}
