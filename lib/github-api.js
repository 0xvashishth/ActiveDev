import { GITHUB_API_BASE } from './constants.js';
import { getAccessToken } from './auth.js';

async function apiRequest(endpoint, options = {}) {
  const token = await getAccessToken();
  if (!token) {
    throw new Error('Not authenticated');
  }

  const url = `${GITHUB_API_BASE}${endpoint}`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github.v3+json',
    ...options.headers,
  };

  const response = await fetch(url, { ...options, headers });

  if (response.status === 401) {
    throw new Error('Token expired or invalid. Please re-authenticate.');
  }

  if (response.status === 403) {
    const rateLimit = response.headers.get('X-RateLimit-Remaining');
    if (rateLimit === '0') {
      const resetTime = response.headers.get('X-RateLimit-Reset');
      const resetDate = new Date(parseInt(resetTime) * 1000);
      throw new Error(`GitHub API rate limit exceeded. Resets at ${resetDate.toLocaleTimeString()}`);
    }
    const errorBody = await response.json().catch(() => null);
    throw new Error(`Access forbidden: ${errorBody?.message || response.statusText}`);
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(`GitHub API error (${response.status}): ${error.message}`);
  }

  return response.json();
}

function parseRepoUrl(repositoryUrl) {
  const parts = repositoryUrl.split('/');
  return {
    owner: parts[parts.length - 2],
    repo: parts[parts.length - 1],
  };
}

export async function getCurrentUser() {
  return apiRequest('/user');
}

export async function validateToken() {
  try {
    await getCurrentUser();
    return true;
  } catch {
    return false;
  }
}

async function searchIssues(query) {
  const response = await apiRequest(
    `/search/issues?q=${encodeURIComponent(query)}&per_page=${encodeURIComponent(30)}&sort=${encodeURIComponent('updated')}`
  );
  return response.items || [];
}

export async function getReviewRequestsForUser(username) {
  return searchIssues(`review-requested:${username} type:pr is:open`);
}

export async function getUserPRs(username) {
  return searchIssues(`author:${username} type:pr is:open`);
}

export async function getPRReviews(owner, repo, pullNumber) {
  return apiRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`);
}

export async function getPRCommits(owner, repo, pullNumber) {
  return apiRequest(`/repos/${owner}/${repo}/pulls/${pullNumber}/commits?per_page=1`);
}

export async function getCommitStatus(owner, repo, ref) {
  return apiRequest(`/repos/${owner}/${repo}/commits/${ref}/status`);
}

export async function getCheckRuns(owner, repo, ref) {
  return apiRequest(`/repos/${owner}/${repo}/commits/${ref}/check-runs`);
}

export async function enrichReviewRequest(pr) {
  const { owner, repo } = parseRepoUrl(pr.repository_url);
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    htmlUrl: pr.html_url,
    repositoryUrl: pr.repository_url,
    owner,
    repo,
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    author: pr.user?.login,
    state: pr.state,
    draft: pr.draft || false,
  };
}

export async function enrichMyPR(pr) {
  const { owner, repo } = parseRepoUrl(pr.repository_url);

  try {
    const [commits, reviews] = await Promise.allSettled([
      getPRCommits(owner, repo, pr.number),
      getPRReviews(owner, repo, pr.number),
    ]);

    const latestCommitSha = commits.status === 'fulfilled' && commits.value.length > 0
      ? commits.value[0].sha
      : null;

    let commitStatus = null;
    let checkRuns = [];

    if (latestCommitSha) {
      const [statusResult, checksResult] = await Promise.allSettled([
        getCommitStatus(owner, repo, latestCommitSha),
        getCheckRuns(owner, repo, latestCommitSha),
      ]);

      if (statusResult.status === 'fulfilled') {
        commitStatus = statusResult.value;
      }
      if (checksResult.status === 'fulfilled') {
        checkRuns = checksResult.value.check_runs || [];
      }
    }

    const reviewData = reviews.status === 'fulfilled' ? reviews.value : [];
    const reviewAnalysis = analyzeReviews(reviewData);

    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      htmlUrl: pr.html_url,
      repositoryUrl: pr.repository_url,
      owner,
      repo,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      author: pr.user?.login,
      state: pr.state,
      draft: pr.draft || false,
      reviews: reviewData,
      ...reviewAnalysis,
      commitStatus,
      checkRuns,
      ciState: determineCIState(commitStatus, checkRuns),
    };
  } catch (error) {
    return {
      id: pr.id,
      number: pr.number,
      title: pr.title,
      htmlUrl: pr.html_url,
      repositoryUrl: pr.repository_url,
      owner,
      repo,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      author: pr.user?.login,
      state: pr.state,
      draft: pr.draft || false,
      error: true,
      errorMessage: error.message,
    };
  }
}

function analyzeReviews(reviews) {
  const latestByUser = new Map();

  for (const review of reviews) {
    const state = review.state?.toUpperCase();
    if (['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED'].includes(state)) {
      const existing = latestByUser.get(review.user.login);
      if (!existing || new Date(review.submitted_at) > new Date(existing.submitted_at)) {
        latestByUser.set(review.user.login, review);
      }
    }
  }

  const approvals = [];
  const changesRequested = [];
  const commenters = [];

  for (const review of latestByUser.values()) {
    switch (review.state.toUpperCase()) {
      case 'APPROVED':
        approvals.push(review.user.login);
        break;
      case 'CHANGES_REQUESTED':
        changesRequested.push(review.user.login);
        break;
      case 'COMMENTED':
        commenters.push(review.user.login);
        break;
    }
  }

  let reviewState = 'pending';
  if (changesRequested.length > 0) {
    reviewState = 'changes_requested';
  } else if (approvals.length > 0) {
    reviewState = 'approved';
  }

  return {
    reviewState,
    approvals,
    changesRequested,
    commenters,
    totalReviews: reviews.length,
  };
}

function determineCIState(commitStatus, checkRuns) {
  if (!commitStatus) return 'unknown';

  if (commitStatus.state === 'failure') return 'failing';
  if (commitStatus.state === 'pending') return 'pending';

  if (checkRuns.length > 0) {
    const hasFailure = checkRuns.some(r => r.conclusion === 'failure' || r.conclusion === 'timed_out' || r.conclusion === 'cancelled');
    if (hasFailure) return 'failing';

    const hasPending = checkRuns.some(r => r.status === 'queued' || r.status === 'in_progress' || r.conclusion === 'neutral');
    if (hasPending) return 'pending';

    const allPassed = checkRuns.every(r => r.conclusion === 'success' || r.conclusion === 'skipped');
    if (allPassed) return 'passing';
  }

  if (commitStatus.state === 'success') return 'passing';
  return 'unknown';
}
