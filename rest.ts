// GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments, pull requests, files and squash merges.

import type { ServerResponse } from 'node:http';
import type { ForgeStore, Issue, Pull, Repo } from './store.ts';
import { FIXED_EPOCH_SEC, FIXED_ISO, VIEWER, serverIdentity } from './store.ts';
import {
  buildCommit,
  diffTrees,
  isOid,
  lineDiff,
  listPath,
  mergeBase,
  parseCommit,
  parseTree,
  putObject,
  readPath,
  threeWayMerge,
  updateTree,
} from './gitops.ts';
import { b64decode, isRecord, paginate, sendError, sendJson, sendNoContent } from './util.ts';

export interface RestArgs {
  store: ForgeStore;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  json: unknown;
  jsonError: boolean;
  baseUrl: string;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
  };
}

function branchJson(repo: Repo, name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha }, protected: false };
}

function personOf(line: string): { name: string; email: string } {
  const match = /^(.*) <(.*)> \d+ [+-]\d{4}$/.exec(line);
  if (match !== null) return { name: match[1] ?? '', email: match[2] ?? '' };
  return { name: line, email: '' };
}

function commitMessageOf(data: Buffer): string {
  const message = parseCommit(data).message;
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = personOf(commit.author);
  const committer = personOf(commit.committer);
  return {
    sha,
    commit: {
      message: commitMessageOf(object.data),
      author: { name: author.name, email: author.email },
      committer: { name: committer.name, email: committer.email },
    },
    author: { login: VIEWER.login },
    committer: { login: VIEWER.login },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.find((entry) => entry.name === name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER.login },
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? pull.mergedAt : null,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER.login },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

/** The tip commit of a branch, or null when the branch has no commit yet. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/** Resolve a `ref` query value (branch name or commit id) to a commit, or null. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return branchTip(repo, repo.defaultBranch);
  const byBranch = branchTip(repo, ref);
  if (byBranch !== null) return byBranch;
  if (isOid(ref)) {
    const object = repo.objects.get(ref);
    if (object !== undefined && object.type === 'commit') return ref;
  }
  return null;
}

/** Create a commit on `branch`, making the branch when it does not exist yet. */
export function commitOnBranch(repo: Repo, branch: string, treeOid: string, parents: string[], message: string): string {
  const data = buildCommit({
    tree: treeOid,
    parents,
    message,
    author: serverIdentity(),
    committer: serverIdentity(),
    timestamp: FIXED_EPOCH_SEC,
  });
  const sha = putObject(repo.objects, 'commit', data);
  repo.refs.set(`refs/heads/${branch}`, sha);
  return sha;
}

function emptyTreeOid(repo: Repo): string {
  return putObject(repo.objects, 'tree', Buffer.from('', 'utf8'));
}

export function treeOidOf(repo: Repo, commitOid: string | null): string {
  if (commitOid === null) return emptyTreeOid(repo);
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return emptyTreeOid(repo);
  return parseCommit(object.data).tree;
}

/** The commit history walking back from `tip`, newest first. */
function historyFrom(repo: Repo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let index = parents.length - 1; index >= 0; index -= 1) stack.push(parents[index]!);
  }
  return out;
}

function validRepoName(name: string): boolean {
  return name !== '' && name.length <= 100 && !name.includes('/') && !/[\s]/.test(name);
}

export function handleRest(args: RestArgs, res: ServerResponse): boolean {
  const { store, method, segments, query } = args;
  const seg = (index: number): string | undefined => segments[index];

  // GET /api/v3/ and /api/v3/meta are public; the rest needs the token (checked by app.ts).
  if (segments.length === 0) {
    if (method !== 'GET') return false;
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (segments.length === 1 && seg(0) === 'meta') {
    if (method !== 'GET') return false;
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }
  if (segments.length === 1 && seg(0) === 'user' && method === 'GET') {
    sendJson(res, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
    });
    return true;
  }
  if (segments.length === 2 && seg(0) === 'user' && seg(1) === 'repos') {
    if (method === 'GET') {
      const { page, link } = paginate(store.viewerRepos(), query, args.baseUrl, '/api/v3/user/repos');
      sendJson(res, 200, page.map((repo) => repoJson(repo)), link !== null ? { link } : {});
      return true;
    }
    if (method === 'POST') return createRepo(args, res, VIEWER.login);
    return false;
  }
  if (segments.length === 3 && seg(0) === 'orgs' && seg(2) === 'repos' && method === 'POST') {
    return createRepo(args, res, seg(1)!);
  }
  if (seg(0) !== 'repos' || segments.length < 3) return false;
  const owner = seg(1)!;
  const name = seg(2)!;
  const repo = store.getRepo(owner, name);
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') {
      if (repo === undefined) return sendError(res, 404, 'Not Found'), true;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      if (repo === undefined) return sendError(res, 404, 'Not Found'), true;
      if (args.jsonError) return sendError(res, 400, 'malformed JSON body'), true;
      if (isRecord(args.json)) {
        if (typeof args.json.description === 'string') repo.description = args.json.description;
        if (typeof args.json.private === 'boolean') repo.isPrivate = args.json.private;
        if (typeof args.json.default_branch === 'string' && args.json.default_branch !== '') {
          repo.defaultBranch = args.json.default_branch;
        }
      }
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      if (repo === undefined) return sendError(res, 404, 'Not Found'), true;
      store.deleteRepo(owner, name);
      sendNoContent(res);
      return true;
    }
    return false;
  }

  if (repo === undefined) {
    // Every deeper route needs the repository to exist.
    if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      return sendError(res, 404, 'Not Found'), true;
    }
    return false;
  }

  const head = rest[0]!;
  if (head === 'branches' && method === 'GET') {
    if (rest.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => branchJson(repo, ref.slice('refs/heads/'.length), sha));
      sendJson(res, 200, branches);
      return true;
    }
    const branch = rest.slice(1).join('/');
    const tip = branchTip(repo, branch);
    if (tip === null) return sendError(res, 404, 'Not Found'), true;
    sendJson(res, 200, branchJson(repo, branch, tip));
    return true;
  }

  if (head === 'commits' && method === 'GET' && rest.length === 1) {
    const tip = resolveRef(repo, query.get('sha'));
    if (tip === null) return sendError(res, 404, 'Not Found'), true;
    const history = historyFrom(repo, tip);
    const { page, link } = paginate(history, query, args.baseUrl, `/api/v3/repos/${owner}/${name}/commits`);
    const items: Record<string, unknown>[] = [];
    for (const sha of page) {
      const item = commitJson(repo, sha);
      if (item !== null) items.push(item);
    }
    sendJson(res, 200, items, link !== null ? { link } : {});
    return true;
  }

  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    if (method === 'GET') return getContents(args, res, repo, path);
    if (method === 'PUT') return putContents(args, res, repo, path);
    if (method === 'DELETE') return deleteContents(args, res, repo, path);
    return false;
  }

  if (head === 'labels') {
    if (method === 'GET' && rest.length === 1) {
      sendJson(res, 200, repo.labels.map((label) => ({ name: label.name, color: label.color, default: false })));
      return true;
    }
    if (method === 'POST' && rest.length === 1) {
      if (args.jsonError) return sendError(res, 400, 'malformed JSON body'), true;
      const body = isRecord(args.json) ? args.json : {};
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (labelName === '') return sendError(res, 422, 'label name is required'), true;
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      const existing = repo.labels.find((label) => label.name === labelName);
      if (existing !== undefined) {
        sendJson(res, 201, { name: existing.name, color: existing.color, default: false });
        return true;
      }
      repo.labels.push({ name: labelName, color });
      sendJson(res, 201, { name: labelName, color, default: false });
      return true;
    }
    return false;
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      if (args.jsonError) return sendError(res, 400, 'malformed JSON body'), true;
      const body = isRecord(args.json) ? args.json : {};
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !isOid(sha)) return sendError(res, 422, 'invalid ref or sha'), true;
      if (!repo.objects.has(sha)) return sendError(res, 422, 'object does not exist'), true;
      if (repo.refs.has(ref)) return sendError(res, 422, 'reference already exists'), true;
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha } });
      return true;
    }
    if (method === 'GET' && rest.length === 2) {
      const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } }));
      sendJson(res, 200, refs);
      return true;
    }
    if (method === 'GET' && rest.length > 2) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return sendError(res, 404, 'Not Found'), true;
      sendJson(res, 200, { ref, object: { sha } });
      return true;
    }
    return false;
  }

  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') return listIssues(args, res, repo);
      if (method === 'POST') return createIssue(args, res, repo);
      return false;
    }
    const number = Number.parseInt(rest[1] ?? '', 10);
    if (!Number.isInteger(number)) return false;
    const issue = repo.issues.find((entry) => entry.number === number);
    if (rest.length === 2) {
      if (method === 'GET') {
        if (issue === undefined) return sendError(res, 404, 'Not Found'), true;
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        if (issue === undefined) return sendError(res, 404, 'Not Found'), true;
        if (args.jsonError) return sendError(res, 400, 'malformed JSON body'), true;
        if (isRecord(args.json)) {
          if (args.json.state === 'open' || args.json.state === 'closed') issue.state = args.json.state;
          if (typeof args.json.title === 'string') issue.title = args.json.title;
          if (typeof args.json.body === 'string') issue.body = args.json.body;
        }
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      return false;
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return sendError(res, 404, 'Not Found'), true;
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((comment) => ({
          id: comment.id,
          body: comment.body,
          user: { login: VIEWER.login },
          created_at: FIXED_ISO,
        })));
        return true;
      }
      if (method === 'POST') {
        if (args.jsonError) return sendError(res, 400, 'malformed JSON body'), true;
        const body = isRecord(args.json) ? args.json : {};
        const text = typeof body.body === 'string' ? body.body : '';
        const comment = { id: repo.nextComment, body: text };
        repo.nextComment += 1;
        issue.comments.push(comment);
        sendJson(res, 201, { id: comment.id, body: comment.body, user: { login: VIEWER.login }, created_at: FIXED_ISO });
        return true;
      }
      return false;
    }
    return false;
  }

  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') return listPulls(args, res, repo);
      if (method === 'POST') return createPull(args, res, repo);
      return false;
    }
    const number = Number.parseInt(rest[1] ?? '', 10);
    if (!Number.isInteger(number)) return false;
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (rest.length === 2 && method === 'GET') {
      if (pull === undefined) return sendError(res, 404, 'Not Found'), true;
      sendJson(res, 200, pullJson(repo, pull));
      return true;
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pull === undefined) return sendError(res, 404, 'Not Found'), true;
      return pullFiles(args, res, repo, pull);
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pull === undefined) return sendError(res, 404, 'Not Found'), true;
      return mergePull(args, res, repo, pull);
    }
    return false;
  }

  return false;
}

function createRepo(args: RestArgs, res: ServerResponse, owner: string): boolean {
  if (args.jsonError) return sendError(res, 400, 'malformed JSON body'), true;
  const body = isRecord(args.json) ? args.json : {};
  const name = typeof body.name === 'string' ? body.name : '';
  if (!validRepoName(name)) return sendError(res, 422, 'invalid repository name'), true;
  if (args.store.getRepo(owner, name) !== undefined) {
    return sendError(res, 422, `Repository ${owner}/${name} already exists`), true;
  }
  const description = typeof body.description === 'string' ? body.description : '';
  const isPrivate = typeof body.private === 'boolean' ? body.private : false;
  const repo = args.store.createRepo(owner, name, description, isPrivate);
  sendJson(res, 201, repoJson(repo));
  return true;
}

function getContents(args: RestArgs, res: ServerResponse, repo: Repo, path: string): boolean {
  const tip = resolveRef(repo, args.query.get('ref'));
  if (tip === null) return sendError(res, 404, 'Not Found'), true;
  if (path === '') {
    const entries = listPath(repo.objects, tip, '');
    if (entries === null) return sendError(res, 404, 'Not Found'), true;
    sendJson(res, 200, entries.map((entry) => dirEntryJson(repo, entry, '')));
    return true;
  }
  const segments = path.split('/').filter((segment) => segment !== '');
  const blob = readPath(repo.objects, tip, path);
  if (blob !== null) {
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: segments[segments.length - 1] ?? '',
      path,
      sha: blob.oid,
      content: blob.data.toString('base64'),
    });
    return true;
  }
  const entries = listPath(repo.objects, tip, path);
  if (entries === null) return sendError(res, 404, 'Not Found'), true;
  sendJson(res, 200, entries.map((entry) => dirEntryJson(repo, entry, path)));
  return true;
}

function dirEntryJson(repo: Repo, entry: { mode: string; name: string; oid: string }, dir: string): Record<string, unknown> {
  const isDir = entry.mode === '40000';
  const out: Record<string, unknown> = {
    type: isDir ? 'dir' : 'file',
    name: entry.name,
    path: dir === '' ? entry.name : `${dir}/${entry.name}`,
    sha: entry.oid,
  };
  if (!isDir) {
    const blob = repo.objects.get(entry.oid);
    if (blob !== undefined) out.size = blob.data.length;
  }
  return out;
}

function putContents(args: RestArgs, res: ServerResponse, repo: Repo, path: string): boolean {
  if (args.jsonError) return sendError(res, 400, 'malformed JSON body'), true;
  const body = isRecord(args.json) ? args.json : {};
  const message = typeof body.message === 'string' ? body.message : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (message === '' || content === '') return sendError(res, 422, 'message and content are required'), true;
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return sendError(res, 422, 'a file path is required'), true;
  let tip = branchTip(repo, branch);
  if (tip === null) {
    // A new branch starts from the default branch's tip, if there is one.
    const base = branch === repo.defaultBranch ? null : branchTip(repo, repo.defaultBranch);
    if (base !== null) repo.refs.set(`refs/heads/${branch}`, base);
    tip = base;
  }
  const current = tip === null ? null : readPath(repo.objects, tip, path);
  const givenSha = typeof body.sha === 'string' ? body.sha : '';
  if (current !== null && givenSha !== '' && givenSha.toLowerCase() !== current.oid.toLowerCase()) {
    return sendError(res, 409, 'sha does not match the current file'), true;
  }
  const bytes = b64decode(content);
  const blobOid = putObject(repo.objects, 'blob', bytes);
  const newTree = updateTree(repo.objects, treeOidOf(repo, tip), segments, blobOid);
  const parents = tip === null ? [] : [tip];
  const commitSha = commitOnBranch(repo, branch, newTree, parents, message);
  sendJson(res, current === null ? 201 : 200, {
    content: {
      name: segments[segments.length - 1] ?? '',
      path,
      sha: blobOid,
      size: bytes.length,
      type: 'file',
      encoding: 'base64',
    },
    commit: { sha: commitSha, message },
  });
  return true;
}

function deleteContents(args: RestArgs, res: ServerResponse, repo: Repo, path: string): boolean {
  if (args.jsonError) return sendError(res, 400, 'malformed JSON body'), true;
  const body = isRecord(args.json) ? args.json : {};
  const message = typeof body.message === 'string' ? body.message : '';
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (tip === null) return sendError(res, 404, 'Not Found'), true;
  const current = readPath(repo.objects, tip, path);
  if (current === null) return sendError(res, 404, 'Not Found'), true;
  const givenSha = typeof body.sha === 'string' ? body.sha : '';
  if (givenSha !== '' && givenSha.toLowerCase() !== current.oid.toLowerCase()) {
    return sendError(res, 409, 'sha does not match the current file'), true;
  }
  const segments = path.split('/').filter((segment) => segment !== '');
  const newTree = updateTree(repo.objects, treeOidOf(repo, tip), segments, null);
  const commitSha = commitOnBranch(repo, branch, newTree, [tip], message);
  sendJson(res, 200, { commit: { sha: commitSha, message } });
  return true;
}

function listIssues(args: RestArgs, res: ServerResponse, repo: Repo): boolean {
  const state = args.query.get('state') ?? 'open';
  let issues = repo.issues;
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  else if (state !== 'all') issues = issues.filter((issue) => issue.state === 'open');
  const direction = args.query.get('direction') ?? 'desc';
  const sorted = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const { page, link } = paginate(sorted, args.query, args.baseUrl, `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
  sendJson(res, 200, page.map((issue) => issueJson(repo, issue)), link !== null ? { link } : {});
  return true;
}

function createIssue(args: RestArgs, res: ServerResponse, repo: Repo): boolean {
  if (args.jsonError) return sendError(res, 400, 'malformed JSON body'), true;
  const body = isRecord(args.json) ? args.json : {};
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return sendError(res, 422, 'title is required'), true;
  const labels = Array.isArray(body.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.some((entry) => entry.name === label)) {
      return sendError(res, 422, `label "${label}" does not exist`), true;
    }
  }
  const issue: Issue = {
    number: repo.nextIssue,
    id: args.store.nextDatabaseId(),
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    labels,
    comments: [],
    seq: args.store.nextSequence(),
  };
  repo.nextIssue += 1;
  repo.issues.push(issue);
  sendJson(res, 201, issueJson(repo, issue));
  return true;
}

function listPulls(args: RestArgs, res: ServerResponse, repo: Repo): boolean {
  const state = args.query.get('state') ?? 'open';
  let pulls = repo.pulls;
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  else if (state !== 'all') pulls = pulls.filter((pull) => pull.state === 'open');
  const sorted = [...pulls].sort((a, b) => b.seq - a.seq);
  const { page, link } = paginate(sorted, args.query, args.baseUrl, `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
  sendJson(res, 200, page.map((pull) => pullJson(repo, pull)), link !== null ? { link } : {});
  return true;
}

function createPull(args: RestArgs, res: ServerResponse, repo: Repo): boolean {
  if (args.jsonError) return sendError(res, 400, 'malformed JSON body'), true;
  const body = isRecord(args.json) ? args.json : {};
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : '';
  const title = typeof body.title === 'string' ? body.title : '';
  if (head === '' || base === '' || title === '') return sendError(res, 422, 'head, base and title are required'), true;
  const headTip = branchTip(repo, head);
  const baseTip = branchTip(repo, base);
  if (headTip === null || baseTip === null) return sendError(res, 422, 'head or base branch does not exist'), true;
  const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
  if (duplicate !== undefined) return sendError(res, 422, 'a pull request from this head already exists'), true;
  const baseOid = mergeBase(repo.objects, headTip, baseTip) ?? baseTip;
  const pull: Pull = {
    number: repo.nextPull,
    id: args.store.nextDatabaseId(),
    title,
    body: typeof body.body === 'string' ? body.body : '',
    state: 'open',
    merged: false,
    mergedAt: FIXED_ISO,
    mergeCommitSha: null,
    headRef: head,
    baseRef: base,
    headSha: headTip,
    baseSha: baseTip,
    mergeBaseSha: baseOid,
    seq: args.store.nextSequence(),
  };
  repo.nextPull += 1;
  repo.pulls.push(pull);
  sendJson(res, 201, pullJson(repo, pull));
  return true;
}

function pullFiles(args: RestArgs, res: ServerResponse, repo: Repo, pull: Pull): boolean {
  const headTip = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const baseOid = mergeBase(repo.objects, headTip, baseTip) ?? pull.mergeBaseSha;
  const baseTree = treeOidOf(repo, baseOid);
  const headTree = treeOidOf(repo, headTip);
  const changes = diffTrees(repo.objects, baseTree, headTree);
  const files = changes.map((change) => {
    const oldText = change.oldOid === null ? '' : (repo.objects.get(change.oldOid)?.data.toString('utf8') ?? '');
    const newText = change.newOid === null ? '' : (repo.objects.get(change.newOid)?.data.toString('utf8') ?? '');
    const counts = lineDiff(oldText, newText);
    return {
      filename: change.path,
      status: change.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: change.newOid ?? change.oldOid ?? '',
    };
  });
  sendJson(res, 200, files);
  return true;
}

function mergePull(args: RestArgs, res: ServerResponse, repo: Repo, pull: Pull): boolean {
  const result = doMergePull(repo, pull);
  if (!result.ok) return sendError(res, result.status, result.message), true;
  sendJson(res, 200, { merged: true, sha: result.sha, message: result.message });
  return true;
}

/** Squash-merge an open pull request onto its base branch (shared by REST, GraphQL, MCP). */
export function doMergePull(repo: Repo, pull: Pull): { ok: true; sha: string; message: string } | { ok: false; status: number; message: string } {
  if (pull.state !== 'open') return { ok: false, status: 405, message: 'pull request is not open' };
  const headTip = branchTip(repo, pull.headRef);
  const baseTip = branchTip(repo, pull.baseRef);
  if (headTip === null || baseTip === null) return { ok: false, status: 405, message: 'head or base branch is missing' };
  const baseOid = mergeBase(repo.objects, headTip, baseTip) ?? pull.mergeBaseSha;
  const merged = threeWayMerge(repo.objects, baseOid, headTip, baseTip);
  if (merged.conflict || merged.treeOid === null) {
    return { ok: false, status: 405, message: 'merge conflict' };
  }
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const mergeSha = commitOnBranch(repo, pull.baseRef, merged.treeOid, [baseTip], message);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_ISO;
  pull.mergeCommitSha = mergeSha;
  return { ok: true, sha: mergeSha, message };
}
