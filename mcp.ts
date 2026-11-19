// MCP (Model Context Protocol) over Streamable HTTP: the legacy era only —
// `server/discover` is refused, `initialize` echoes the offered revision,
// and six tools cover repos, issues and pull requests.

import type { ServerResponse } from 'node:http';
import type { ForgeStore, Issue, Pull, Repo } from './store.ts';
import { FIXED_ISO, VIEWER } from './store.ts';
import { mergeBase } from './gitops.ts';
import { branchTip, doMergePull } from './rest.ts';
import { isRecord, sendJson } from './util.ts';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer (or the given owner).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'Owner login; defaults to the viewer.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
        body: { type: 'string', description: 'Pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

function repoSummary(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueSummary(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login },
    created_at: FIXED_ISO,
  };
}

function pullSummary(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = branchTip(repo, pull.baseRef) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? pull.mergedAt : null,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha },
    base: { ref: pull.baseRef, sha: baseSha },
  };
}

function toolText(result: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown; isError: boolean } {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

function toolError(message: string): { content: Array<{ type: 'text'; text: string }>; structuredContent: unknown; isError: boolean } {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { error: message },
    isError: true,
  };
}

function missingArg(tool: string, arg: string): ReturnType<typeof toolError> {
  return toolError(`missing required argument "${arg}" for tool ${tool}`);
}

function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): ReturnType<typeof toolText> | ReturnType<typeof toolError> {
  const ownerOf = (value: unknown): string => (typeof value === 'string' ? value : '');
  const repoOf = (owner: string, repoName: string): Repo | undefined => store.getRepo(owner, repoName);

  if (name === 'create_repo') {
    if (typeof args.name !== 'string' || args.name === '') return missingArg(name, 'name');
    const owner = ownerOf(args.owner) !== '' ? ownerOf(args.owner) : VIEWER.login;
    if (store.getRepo(owner, args.name) !== undefined) {
      return toolError(`Repository ${owner}/${args.name} already exists`);
    }
    const repo = store.createRepo(
      owner,
      args.name,
      typeof args.description === 'string' ? args.description : '',
      typeof args.private === 'boolean' ? args.private : false,
    );
    return toolText(repoSummary(repo));
  }

  if (name === 'get_repo') {
    if (typeof args.owner !== 'string' || args.owner === '') return missingArg(name, 'owner');
    if (typeof args.repo !== 'string' || args.repo === '') return missingArg(name, 'repo');
    const repo = repoOf(args.owner, args.repo);
    if (repo === undefined) return toolError(`Repository ${args.owner}/${args.repo} not found`);
    return toolText(repoSummary(repo));
  }

  if (name === 'create_issue') {
    if (typeof args.owner !== 'string' || args.owner === '') return missingArg(name, 'owner');
    if (typeof args.repo !== 'string' || args.repo === '') return missingArg(name, 'repo');
    if (typeof args.title !== 'string' || args.title === '') return missingArg(name, 'title');
    const repo = repoOf(args.owner, args.repo);
    if (repo === undefined) return toolError(`Repository ${args.owner}/${args.repo} not found`);
    const issue: Issue = {
      number: repo.nextIssue,
      id: store.nextDatabaseId(),
      title: args.title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
      seq: store.nextSequence(),
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return toolText(issueSummary(repo, issue));
  }

  if (name === 'list_issues') {
    if (typeof args.owner !== 'string' || args.owner === '') return missingArg(name, 'owner');
    if (typeof args.repo !== 'string' || args.repo === '') return missingArg(name, 'repo');
    const repo = repoOf(args.owner, args.repo);
    if (repo === undefined) return toolError(`Repository ${args.owner}/${args.repo} not found`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    let issues = repo.issues;
    if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
    else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
    const summaries = issues.map((issue) => issueSummary(repo, issue));
    return {
      content: [{ type: 'text', text: JSON.stringify(summaries) }],
      structuredContent: { issues: summaries },
      isError: false,
    };
  }

  if (name === 'create_pull_request') {
    for (const arg of ['owner', 'repo', 'title', 'head', 'base']) {
      if (typeof args[arg] !== 'string' || args[arg] === '') return missingArg(name, arg);
    }
    const repo = repoOf(args.owner as string, args.repo as string);
    if (repo === undefined) return toolError(`Repository ${args.owner}/${args.repo} not found`);
    const head = args.head as string;
    const base = args.base as string;
    const headTip = branchTip(repo, head);
    const baseTip = branchTip(repo, base);
    if (headTip === null || baseTip === null) return toolError('head or base branch does not exist');
    const duplicate = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
    if (duplicate !== undefined) return toolError('a pull request from this head already exists');
    const pull: Pull = {
      number: repo.nextPull,
      id: store.nextDatabaseId(),
      title: args.title as string,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      merged: false,
      mergedAt: FIXED_ISO,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      mergeBaseSha: mergeBase(repo.objects, headTip, baseTip) ?? baseTip,
      seq: store.nextSequence(),
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return toolText(pullSummary(repo, pull));
  }

  if (name === 'merge_pull_request') {
    if (typeof args.owner !== 'string' || args.owner === '') return missingArg(name, 'owner');
    if (typeof args.repo !== 'string' || args.repo === '') return missingArg(name, 'repo');
    if (typeof args.pull_number !== 'number') return missingArg(name, 'pull_number');
    const repo = repoOf(args.owner, args.repo);
    if (repo === undefined) return toolError(`Repository ${args.owner}/${args.repo} not found`);
    const pull = repo.pulls.find((entry) => entry.number === args.pull_number);
    if (pull === undefined) return toolError(`pull request ${args.pull_number} not found`);
    const result = doMergePull(repo, pull);
    if (!result.ok) return toolError(result.message);
    return toolText({ merged: true, sha: result.sha, message: result.message, number: pull.number });
  }

  return null as unknown as ReturnType<typeof toolText>;
}

export function handleMcp(body: Buffer, store: ForgeStore, res: ServerResponse): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const responses: unknown[] = [];
  for (const request of requests) {
    if (!isRecord(request) || typeof request.method !== 'string' || !('jsonrpc' in request)) {
      responses.push({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      continue;
    }
    const id = 'id' in request ? (request.id as unknown) : undefined;
    const isNotification = id === undefined;
    const method = request.method;
    const params = isRecord(request.params) ? (request.params as Record<string, unknown>) : {};
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      // Notifications get no reply; the client expects a bare 202.
      continue;
    }
    if (method === 'server/discover') {
      responses.push({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: server/discover' } });
      continue;
    }
    if (method === 'initialize') {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      responses.push({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: offered,
          capabilities: { tools: {} },
          serverInfo: { name: 'kai-forge', version: '1.0.0' },
        },
      });
      continue;
    }
    if (method === 'tools/list') {
      responses.push({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      continue;
    }
    if (method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const toolArgs = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
      const known = TOOLS.some((tool) => tool.name === toolName);
      if (!known) {
        responses.push({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${toolName}` } });
        continue;
      }
      const result = callTool(store, toolName, toolArgs);
      responses.push({ jsonrpc: '2.0', id, result });
      continue;
    }
    if (method === 'ping') {
      responses.push({ jsonrpc: '2.0', id, result: {} });
      continue;
    }
    responses.push({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
  if (responses.length === 0) {
    res.writeHead(202);
    res.end();
    return;
  }
  sendJson(res, 200, Array.isArray(parsed) ? responses : responses[0]);
}
