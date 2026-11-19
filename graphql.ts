// GraphQL v4: a small executor for the query shapes the trial uses —
// operations, variables, aliases, inline and named fragments, input objects,
// enums, lists and JSON batching — over the same in-memory store as REST.

import type { ServerResponse } from 'node:http';
import type { ForgeStore, Issue, Pull, Repo } from './store.ts';
import { FIXED_ISO, VIEWER } from './store.ts';
import { diffTrees, lineDiff, mergeBase, threeWayMerge } from './gitops.ts';
import { branchTip, doMergePull, treeOidOf } from './rest.ts';
import { isRecord, sendJson } from './util.ts';

// ---------------------------------------------------------------------------
// Tokenizer and parser for the GraphQL document subset the trial exercises.
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          const esc = src[i + 1] ?? '';
          const table: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(src.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += table[esc] ?? esc;
            i += 2;
          }
        } else {
          value += src[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && src[j]! >= '0' && src[j]! <= '9') j += 1;
      let isFloat = false;
      if (src[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < src.length && src[j]! >= '0' && src[j]! <= '9') j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && src[j]! >= '0' && src[j]! <= '9') j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_') {
      let j = i;
      while (j < src.length && /[_0-9A-Za-z]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (src.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int' | 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, ValueNode>;
  selections: SelectionNode[] | null;
}

interface FragmentSpreadNode {
  kind: 'spread';
  name: string | null;
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode;

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, { defaultValue?: ValueNode }>;
  selections: SelectionNode[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${value} but got ${token.value}`);
    }
  }

  private acceptPunct(value: string): boolean {
    if (this.peek().kind === 'punct' && this.peek().value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(expected?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name but got ${token.value}`);
    if (expected !== undefined && token.value !== expected) {
      throw new Error(`expected ${expected} but got ${token.value}`);
    }
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'name' && this.peek().value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value as 'query' | 'mutation';
      this.next();
      if (this.peek().kind === 'name') name = this.next().value;
    }
    const variables: Record<string, { defaultValue?: ValueNode }> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.acceptPunct('=')) defaultValue = this.parseValue();
        variables[varName] = defaultValue === undefined ? {} : { defaultValue };
        if (this.peek().kind === 'eof') throw new Error('unterminated variable definitions');
      }
    }
    // Directives on the operation (none of the trial's documents use them).
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.acceptPunct('(')) this.parseArguments();
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseType(): void {
    if (this.acceptPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      selections.push(this.parseSelection());
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
    }
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        const selections = this.parseSelectionSet();
        return { kind: 'spread', name: null, typeCondition, selections };
      }
      const name = this.expectName();
      return { kind: 'spread', name, typeCondition: null, selections: [] };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, ValueNode> = {};
    if (this.acceptPunct('(')) {
      Object.assign(args, this.parseArguments());
    }
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.acceptPunct('(')) this.parseArguments();
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArguments(): Record<string, ValueNode> {
    const args: Record<string, ValueNode> = {};
    while (!this.acceptPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args[name] = this.parseValue();
      if (this.peek().kind === 'eof') throw new Error('unterminated arguments');
    }
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int' || token.kind === 'float') {
      return { kind: token.kind, value: Number.parseFloat(token.value) };
    }
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        items.push(this.parseValue());
      }
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected token ${token.value} in value`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'enum':
      return node.value;
    case 'int':
    case 'float':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema: field types for validation and for driving nested execution.
// ---------------------------------------------------------------------------

interface FieldDef {
  type: string;
}

const SCALARS = new Set([
  'String', 'Int', 'Float', 'Boolean', 'ID',
  'IssueState', 'PullRequestState', 'MergeableState', 'RepositoryPermission',
  'SearchType', 'IssueOrderField', 'OrderDirection', 'MergeMethod', 'SearchType',
]);

const ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'PULL_REQUEST', 'COMMIT', 'DISCUSSION', 'REPOSITORY', 'USER', 'ORGANIZATION', 'MILESTONE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

function baseType(type: string): string {
  return type.replace(/[\[\]!]/g, '');
}

function isScalarType(type: string): boolean {
  return SCALARS.has(baseType(type));
}

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { type: 'User' },
    repository: { type: 'Repository' },
    node: { type: 'Node' },
    search: { type: 'SearchResultItemConnection' },
    __type: { type: '__Type' },
    __schema: { type: '__Schema' },
  },
  Mutation: {
    createIssue: { type: 'CreateIssuePayload' },
    closeIssue: { type: 'CloseIssuePayload' },
    createPullRequest: { type: 'CreatePullRequestPayload' },
    mergePullRequest: { type: 'MergePullRequestPayload' },
    addComment: { type: 'AddCommentPayload' },
  },
  Node: {
    id: { type: 'ID' },
  },
  User: {
    id: { type: 'ID' },
    databaseId: { type: 'Int' },
    login: { type: 'String' },
    name: { type: 'String' },
    email: { type: 'String' },
    avatarUrl: { type: 'String' },
    url: { type: 'String' },
  },
  Repository: {
    id: { type: 'ID' },
    databaseId: { type: 'Int' },
    name: { type: 'String' },
    nameWithOwner: { type: 'String' },
    description: { type: 'String' },
    isPrivate: { type: 'Boolean' },
    owner: { type: 'User' },
    defaultBranchRef: { type: 'Ref' },
    viewerPermission: { type: 'RepositoryPermission' },
    hasIssuesEnabled: { type: 'Boolean' },
    url: { type: 'String' },
    issue: { type: 'Issue' },
    issues: { type: 'IssueConnection' },
    pullRequest: { type: 'PullRequest' },
    pullRequests: { type: 'PullRequestConnection' },
    labels: { type: 'LabelConnection' },
  },
  Ref: {
    id: { type: 'ID' },
    name: { type: 'String' },
    target: { type: 'Commit' },
  },
  Commit: {
    oid: { type: 'String' },
    message: { type: 'String' },
  },
  Issue: {
    id: { type: 'ID' },
    number: { type: 'Int' },
    title: { type: 'String' },
    body: { type: 'String' },
    state: { type: 'IssueState' },
    url: { type: 'String' },
    createdAt: { type: 'String' },
    updatedAt: { type: 'String' },
    author: { type: 'User' },
    repository: { type: 'Repository' },
    labels: { type: 'LabelConnection' },
    comments: { type: 'IssueCommentConnection' },
  },
  PullRequest: {
    id: { type: 'ID' },
    number: { type: 'Int' },
    title: { type: 'String' },
    body: { type: 'String' },
    state: { type: 'PullRequestState' },
    merged: { type: 'Boolean' },
    mergedAt: { type: 'String' },
    mergeable: { type: 'MergeableState' },
    headRefName: { type: 'String' },
    baseRefName: { type: 'String' },
    headRefOid: { type: 'String' },
    baseRefOid: { type: 'String' },
    url: { type: 'String' },
    createdAt: { type: 'String' },
    updatedAt: { type: 'String' },
    author: { type: 'User' },
    repository: { type: 'Repository' },
    files: { type: 'PullRequestChangedFileConnection' },
    labels: { type: 'LabelConnection' },
    comments: { type: 'IssueCommentConnection' },
    isDraft: { type: 'Boolean' },
  },
  Label: {
    id: { type: 'ID' },
    name: { type: 'String' },
    color: { type: 'String' },
    description: { type: 'String' },
  },
  IssueComment: {
    id: { type: 'ID' },
    databaseId: { type: 'Int' },
    body: { type: 'String' },
    author: { type: 'User' },
    createdAt: { type: 'String' },
    url: { type: 'String' },
  },
  IssueConnection: {
    nodes: { type: '[Issue]' },
    edges: { type: '[IssueEdge]' },
    pageInfo: { type: 'PageInfo' },
    totalCount: { type: 'Int' },
  },
  IssueEdge: {
    node: { type: 'Issue' },
    cursor: { type: 'String' },
  },
  PullRequestConnection: {
    nodes: { type: '[PullRequest]' },
    edges: { type: '[PullRequestEdge]' },
    pageInfo: { type: 'PageInfo' },
    totalCount: { type: 'Int' },
  },
  PullRequestEdge: {
    node: { type: 'PullRequest' },
    cursor: { type: 'String' },
  },
  IssueCommentConnection: {
    nodes: { type: '[IssueComment]' },
    edges: { type: '[IssueCommentEdge]' },
    pageInfo: { type: 'PageInfo' },
    totalCount: { type: 'Int' },
  },
  IssueCommentEdge: {
    node: { type: 'IssueComment' },
    cursor: { type: 'String' },
  },
  LabelConnection: {
    nodes: { type: '[Label]' },
    edges: { type: '[LabelEdge]' },
    pageInfo: { type: 'PageInfo' },
    totalCount: { type: 'Int' },
  },
  LabelEdge: {
    node: { type: 'Label' },
    cursor: { type: 'String' },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: '[PullRequestChangedFile]' },
    edges: { type: '[PullRequestChangedFileEdge]' },
    pageInfo: { type: 'PageInfo' },
    totalCount: { type: 'Int' },
  },
  PullRequestChangedFileEdge: {
    node: { type: 'PullRequestChangedFile' },
    cursor: { type: 'String' },
  },
  PullRequestChangedFile: {
    path: { type: 'String' },
    additions: { type: 'Int' },
    deletions: { type: 'Int' },
    changeType: { type: 'String' },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean' },
    hasPreviousPage: { type: 'Boolean' },
    startCursor: { type: 'String' },
    endCursor: { type: 'String' },
  },
  SearchResultItemConnection: {
    nodes: { type: '[SearchResultItem]' },
    edges: { type: '[SearchResultItemEdge]' },
    pageInfo: { type: 'PageInfo' },
    totalCount: { type: 'Int' },
  },
  SearchResultItemEdge: {
    node: { type: 'SearchResultItem' },
    cursor: { type: 'String' },
  },
  SearchResultItem: {
    id: { type: 'ID' },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue' },
    clientMutationId: { type: 'String' },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue' },
    clientMutationId: { type: 'String' },
  },
  CreatePullRequestPayload: {
    pullRequest: { type: 'PullRequest' },
    clientMutationId: { type: 'String' },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest' },
    clientMutationId: { type: 'String' },
  },
  AddCommentPayload: {
    commentEdge: { type: 'IssueCommentEdge' },
    clientMutationId: { type: 'String' },
  },
  __Type: {
    name: { type: 'String' },
    kind: { type: 'String' },
    description: { type: 'String' },
    fields: { type: '[__Field]' },
    enumValues: { type: '[__EnumValue]' },
    inputFields: { type: '[__InputValue]' },
  },
  __Field: {
    name: { type: 'String' },
    description: { type: 'String' },
    type: { type: '__Type' },
    args: { type: '[__InputValue]' },
  },
  __EnumValue: {
    name: { type: 'String' },
    description: { type: 'String' },
  },
  __InputValue: {
    name: { type: 'String' },
    description: { type: 'String' },
    type: { type: '__Type' },
    defaultValue: { type: 'String' },
  },
  __Schema: {
    types: { type: '[__Type]' },
    queryType: { type: '__Type' },
    mutationType: { type: '__Type' },
    description: { type: 'String' },
  },
};

// ---------------------------------------------------------------------------
// Global ids: opaque base64 of `Kind:owner/name:...`, stable across reads.
// ---------------------------------------------------------------------------

export function globalId(kind: string, ...parts: string[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '') return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function cursorOf(value: string | number): string {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

// ---------------------------------------------------------------------------
// View objects: every resolvable node carries its __typename plus its store
// handles; the resolvers below read from them.
// ---------------------------------------------------------------------------

interface Ctx {
  store: ForgeStore;
}

type View =
  | { __typename: 'User'; login: string; id: number; name: string; email: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: Pull }
  | { __typename: 'Label'; repo: Repo; label: { name: string; color: string } }
  | { __typename: 'IssueComment'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'Commit'; oid: string; message: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __typename: 'IssueConnection'; nodes: View[]; totalCount: number }
  | { __typename: 'PullRequestConnection'; nodes: View[]; totalCount: number }
  | { __typename: 'IssueCommentConnection'; nodes: View[]; totalCount: number }
  | { __typename: 'LabelConnection'; nodes: View[]; totalCount: number }
  | { __typename: 'PullRequestChangedFileConnection'; nodes: View[]; totalCount: number }
  | { __typename: 'SearchResultItemConnection'; nodes: View[]; totalCount: number }
  | { __typename: 'IssueEdge' | 'PullRequestEdge' | 'IssueCommentEdge' | 'LabelEdge' | 'PullRequestChangedFileEdge' | 'SearchResultItemEdge'; node: View | null; cursor: string }
  | { __typename: 'PullRequestChangedFile'; path: string; additions: number; deletions: number; changeType: string }
  | { __typename: 'CreateIssuePayload'; issue: View | null; clientMutationId: string | null }
  | { __typename: 'CloseIssuePayload'; issue: View | null; clientMutationId: string | null }
  | { __typename: 'CreatePullRequestPayload'; pullRequest: View | null; clientMutationId: string | null }
  | { __typename: 'MergePullRequestPayload'; pullRequest: View | null; clientMutationId: string | null }
  | { __typename: 'AddCommentPayload'; commentEdge: View | null; clientMutationId: string | null }
  | { __typename: '__Type'; name: string; kind: string; fieldNames: string[] | null; enumValues: string[] | null }
  | { __typename: '__Field'; name: string; typeName: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: '__InputValue'; name: string }
  | { __typename: '__Schema' };

function viewerView(): View {
  return { __typename: 'User', login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email };
}

function repoView(repo: Repo): View {
  return { __typename: 'Repository', repo };
}

function issueView(repo: Repo, issue: Issue): View {
  return { __typename: 'Issue', repo, issue };
}

function pullView(repo: Repo, pull: Pull): View {
  return { __typename: 'PullRequest', repo, pull };
}

function pageInfoFor(total: number, start: number, pageLength: number, cursorOfItem: (index: number) => string): View {
  return {
    __typename: 'PageInfo',
    hasNextPage: start + pageLength < total,
    hasPreviousPage: start > 0,
    startCursor: pageLength > 0 ? cursorOfItem(start) : null,
    endCursor: pageLength > 0 ? cursorOfItem(start + pageLength - 1) : null,
  };
}

interface ConnectionSlice<T> {
  nodes: T[];
  totalCount: number;
  start: number;
  pageLength: number;
}

/** Apply `first`/`after` to an already ordered list. */
function sliceConnection<T>(
  items: T[],
  args: Record<string, unknown>,
  cursorOfItem: (item: T) => string,
): ConnectionSlice<T> {
  let start = 0;
  const after = typeof args.after === 'string' ? args.after : null;
  if (after !== null) {
    const index = items.findIndex((item) => cursorOfItem(item) === after);
    if (index >= 0) start = index + 1;
  }
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : items.length;
  const nodes = items.slice(start, start + first);
  return { nodes, totalCount: items.length, start, pageLength: nodes.length };
}

function orderIssues(issues: Issue[], args: Record<string, unknown>): Issue[] {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let filtered = issues;
  if (states !== null) {
    const wanted = new Set(states.map((state) => state.toLowerCase()));
    filtered = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  return [...filtered].sort((a, b) => (a.seq - b.seq) * direction);
}

function orderPulls(pulls: Pull[], args: Record<string, unknown>): Pull[] {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let filtered = pulls;
  if (states !== null) {
    filtered = pulls.filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
      return states.includes(state);
    });
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  return [...filtered].sort((a, b) => (a.seq - b.seq) * direction);
}

// ---------------------------------------------------------------------------
// Resolvers.
// ---------------------------------------------------------------------------

type Resolver = (src: View, args: Record<string, unknown>, ctx: Ctx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => viewerView(),
    repository: (_src, args, ctx) => {
      const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoView(repo);
    },
    node: (_src, args, ctx) => resolveNode(String(args.id ?? ''), ctx),
    search: () => ({ __typename: 'SearchResultItemConnection', nodes: [], totalCount: 0 }) as View,
    __type: (_src, args) => typeView(String(args.name ?? '')),
    __schema: () => ({ __typename: '__Schema' }) as View,
  },
  Mutation: {
    createIssue: (_src, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'Repository' || decoded.parts.length < 1) {
        throw new Error('repositoryId does not name a repository');
      }
      const [ownerName] = decoded.parts;
      const [owner, name] = (ownerName ?? '').split('/');
      const repo = ctx.store.getRepo(owner ?? '', name ?? '');
      if (repo === undefined) throw new Error('repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      const labels = Array.isArray(input.labels) ? input.labels.filter((label): label is string => typeof label === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.some((entry) => entry.name === label)) {
          throw new Error(`label "${label}" does not exist`);
        }
      }
      const issue: Issue = {
        number: repo.nextIssue,
        id: ctx.store.nextDatabaseId(),
        title,
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels,
        comments: [],
        seq: ctx.store.nextSequence(),
      };
      repo.nextIssue += 1;
      repo.issues.push(issue);
      return {
        __typename: 'CreateIssuePayload',
        issue: issueView(repo, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      } as View;
    },
    closeIssue: (_src, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue' || decoded.parts.length < 2) {
        throw new Error('issueId does not name an issue');
      }
      const [ownerName, numberText] = decoded.parts;
      const [owner, name] = (ownerName ?? '').split('/');
      const repo = ctx.store.getRepo(owner ?? '', name ?? '');
      const issue = repo?.issues.find((entry) => entry.number === Number.parseInt(numberText ?? '', 10));
      if (issue === undefined || repo === undefined) throw new Error('issue not found');
      issue.state = 'closed';
      return {
        __typename: 'CloseIssuePayload',
        issue: issueView(repo, issue),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      } as View;
    },
    createPullRequest: (_src, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'Repository' || decoded.parts.length < 1) {
        throw new Error('repositoryId does not name a repository');
      }
      const [ownerName] = decoded.parts;
      const [owner, name] = (ownerName ?? '').split('/');
      const repo = ctx.store.getRepo(owner ?? '', name ?? '');
      if (repo === undefined) throw new Error('repository not found');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headTip = branchTip(repo, headRef);
      const baseTip = branchTip(repo, baseRef);
      if (headTip === null || baseTip === null) throw new Error('head or base branch does not exist');
      const existing = repo.pulls.find((pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef);
      if (existing !== undefined) {
        return {
          __typename: 'CreatePullRequestPayload',
          pullRequest: pullView(repo, existing),
          clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
        } as View;
      }
      const pull: Pull = {
        number: repo.nextPull,
        id: ctx.store.nextDatabaseId(),
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        merged: false,
        mergedAt: FIXED_ISO,
        mergeCommitSha: null,
        headRef,
        baseRef,
        headSha: headTip,
        baseSha: baseTip,
        mergeBaseSha: mergeBase(repo.objects, headTip, baseTip) ?? baseTip,
        seq: ctx.store.nextSequence(),
      };
      repo.nextPull += 1;
      repo.pulls.push(pull);
      return {
        __typename: 'CreatePullRequestPayload',
        pullRequest: pullView(repo, pull),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      } as View;
    },
    mergePullRequest: (_src, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'PullRequest' || decoded.parts.length < 2) {
        throw new Error('pullRequestId does not name a pull request');
      }
      const [ownerName, numberText] = decoded.parts;
      const [owner, name] = (ownerName ?? '').split('/');
      const repo = ctx.store.getRepo(owner ?? '', name ?? '');
      const pull = repo?.pulls.find((entry) => entry.number === Number.parseInt(numberText ?? '', 10));
      if (pull === undefined || repo === undefined) throw new Error('pull request not found');
      const result = doMergePull(repo, pull);
      if (!result.ok) throw new Error(result.message);
      return {
        __typename: 'MergePullRequestPayload',
        pullRequest: pullView(repo, pull),
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      } as View;
    },
    addComment: (_src, args, ctx) => {
      const input = isRecord(args.input) ? args.input : {};
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null || decoded.parts.length < 2) throw new Error('subjectId does not name a subject');
      const [ownerName, numberText] = decoded.parts;
      const [owner, name] = (ownerName ?? '').split('/');
      const repo = ctx.store.getRepo(owner ?? '', name ?? '');
      if (repo === undefined) throw new Error('subject not found');
      const body = typeof input.body === 'string' ? input.body : '';
      let comment: { id: number; body: string } | null = null;
      let edge: View | null = null;
      if (decoded.kind === 'Issue') {
        const issue = repo.issues.find((entry) => entry.number === Number.parseInt(numberText ?? '', 10));
        if (issue === undefined) throw new Error('issue not found');
        comment = { id: repo.nextComment, body };
        repo.nextComment += 1;
        issue.comments.push(comment);
        edge = {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', repo, issue, comment } as View,
          cursor: cursorOf(comment.id),
        } as View;
      } else if (decoded.kind === 'PullRequest') {
        const pull = repo.pulls.find((entry) => entry.number === Number.parseInt(numberText ?? '', 10));
        if (pull === undefined) throw new Error('pull request not found');
        // Pull-request comments ride on the pull's own comment list via a synthetic issue.
        comment = { id: repo.nextComment, body };
        repo.nextComment += 1;
        edge = {
          __typename: 'IssueCommentEdge',
          node: { __typename: 'IssueComment', repo, issue: { number: pull.number, id: pull.id, title: pull.title, body: pull.body, state: pull.state, labels: [], comments: [comment], seq: pull.seq } as Issue, comment } as View,
          cursor: cursorOf(comment.id),
        } as View;
      } else {
        throw new Error('subjectId does not name a commentable subject');
      }
      return {
        __typename: 'AddCommentPayload',
        commentEdge: edge,
        clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
      } as View;
    },
  },
  Node: {
    id: (src) => nodeIdOf(src),
  },
  User: {
    id: (src) => globalId('User', (src as { login: string }).login),
    databaseId: (src) => (src as { id: number }).id,
    login: (src) => (src as { login: string }).login,
    name: (src) => (src as { name: string }).name,
    email: (src) => (src as { email: string }).email,
    avatarUrl: () => null,
    url: (src) => `https://github.com/${(src as { login: string }).login}`,
  },
  Repository: {
    id: (src) => globalId('Repository', `${(src as { repo: Repo }).repo.owner}/${(src as { repo: Repo }).repo.name}`),
    databaseId: (src) => (src as { repo: Repo }).repo.id,
    name: (src) => (src as { repo: Repo }).repo.name,
    nameWithOwner: (src) => `${(src as { repo: Repo }).repo.owner}/${(src as { repo: Repo }).repo.name}`,
    description: (src) => (src as { repo: Repo }).repo.description,
    isPrivate: (src) => (src as { repo: Repo }).repo.isPrivate,
    owner: (src) => viewerViewFor((src as { repo: Repo }).repo.owner),
    defaultBranchRef: (src) => {
      const repo = (src as { repo: Repo }).repo;
      return branchTip(repo, repo.defaultBranch) === null ? null : { __typename: 'Ref', name: repo.defaultBranch } as View;
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    url: (src) => `https://github.com/${(src as { repo: Repo }).repo.owner}/${(src as { repo: Repo }).repo.name}`,
    issue: (src, args) => {
      const repo = (src as { repo: Repo }).repo;
      const issue = repo.issues.find((entry) => entry.number === Number(args.number ?? 0));
      return issue === undefined ? null : issueView(repo, issue);
    },
    issues: (src, args) => {
      const repo = (src as { repo: Repo }).repo;
      const ordered = orderIssues(repo.issues, args);
      const slice = sliceConnection(ordered, args, (issue) => cursorOf(issue.number));
      return {
        __typename: 'IssueConnection',
        nodes: slice.nodes.map((issue) => issueView(repo, issue)),
        totalCount: slice.totalCount,
        pageInfo: pageInfoFor(slice.totalCount, slice.start, slice.pageLength, (index) => cursorOf(ordered[index]!.number)),
      } as View;
    },
    pullRequest: (src, args) => {
      const repo = (src as { repo: Repo }).repo;
      const pull = repo.pulls.find((entry) => entry.number === Number(args.number ?? 0));
      return pull === undefined ? null : pullView(repo, pull);
    },
    pullRequests: (src, args) => {
      const repo = (src as { repo: Repo }).repo;
      const ordered = orderPulls(repo.pulls, args);
      const slice = sliceConnection(ordered, args, (pull) => cursorOf(pull.number));
      return {
        __typename: 'PullRequestConnection',
        nodes: slice.nodes.map((pull) => pullView(repo, pull)),
        totalCount: slice.totalCount,
        pageInfo: pageInfoFor(slice.totalCount, slice.start, slice.pageLength, (index) => cursorOf(ordered[index]!.number)),
      } as View;
    },
    labels: (src, args) => {
      const repo = (src as { repo: Repo }).repo;
      const slice = sliceConnection(repo.labels, args, (label) => cursorOf(label.name));
      return {
        __typename: 'LabelConnection',
        nodes: slice.nodes.map((label) => ({ __typename: 'Label', repo, label }) as View),
        totalCount: slice.totalCount,
        pageInfo: pageInfoFor(slice.totalCount, slice.start, slice.pageLength, (index) => cursorOf(repo.labels[index]!.name)),
      } as View;
    },
  },
  Ref: {
    id: (src) => globalId('Ref', (src as { name: string }).name),
    name: (src) => (src as { name: string }).name,
    target: () => null,
  },
  Commit: {
    oid: (src) => (src as { oid: string }).oid,
    message: (src) => (src as { message: string }).message,
  },
  Issue: {
    id: (src) => {
      const { repo, issue } = src as { repo: Repo; issue: Issue };
      return globalId('Issue', `${repo.owner}/${repo.name}`, String(issue.number));
    },
    number: (src) => (src as { issue: Issue }).issue.number,
    title: (src) => (src as { issue: Issue }).issue.title,
    body: (src) => (src as { issue: Issue }).issue.body,
    state: (src) => (src as { issue: Issue }).issue.state.toUpperCase(),
    url: (src) => {
      const { repo, issue } = src as { repo: Repo; issue: Issue };
      return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
    },
    createdAt: () => FIXED_ISO,
    updatedAt: () => FIXED_ISO,
    author: () => viewerView(),
    repository: (src) => repoView((src as { repo: Repo }).repo),
    labels: (src, args) => {
      const { repo, issue } = src as { repo: Repo; issue: Issue };
      const labels = issue.labels
        .map((name) => repo.labels.find((entry) => entry.name === name))
        .filter((label): label is { name: string; color: string } => label !== undefined);
      const slice = sliceConnection(labels, args, (label) => cursorOf(label.name));
      return {
        __typename: 'LabelConnection',
        nodes: slice.nodes.map((label) => ({ __typename: 'Label', repo, label }) as View),
        totalCount: slice.totalCount,
        pageInfo: pageInfoFor(slice.totalCount, slice.start, slice.pageLength, (index) => cursorOf(labels[index]!.name)),
      } as View;
    },
    comments: (src, args) => {
      const { repo, issue } = src as { repo: Repo; issue: Issue };
      const slice = sliceConnection(issue.comments, args, (comment) => cursorOf(comment.id));
      return {
        __typename: 'IssueCommentConnection',
        nodes: slice.nodes.map((comment) => ({ __typename: 'IssueComment', repo, issue, comment }) as View),
        totalCount: slice.totalCount,
        pageInfo: pageInfoFor(slice.totalCount, slice.start, slice.pageLength, (index) => cursorOf(issue.comments[index]!.id)),
      } as View;
    },
  },
  PullRequest: {
    id: (src) => {
      const { repo, pull } = src as { repo: Repo; pull: Pull };
      return globalId('PullRequest', `${repo.owner}/${repo.name}`, String(pull.number));
    },
    number: (src) => (src as { pull: Pull }).pull.number,
    title: (src) => (src as { pull: Pull }).pull.title,
    body: (src) => (src as { pull: Pull }).pull.body,
    state: (src) => {
      const pull = (src as { pull: Pull }).pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (src) => (src as { pull: Pull }).pull.merged,
    mergedAt: (src) => {
      const pull = (src as { pull: Pull }).pull;
      return pull.merged ? pull.mergedAt : null;
    },
    mergeable: (src) => {
      const { repo, pull } = src as { repo: Repo; pull: Pull };
      if (pull.state !== 'open') return 'UNKNOWN';
      const headTip = branchTip(repo, pull.headRef);
      const baseTip = branchTip(repo, pull.baseRef);
      if (headTip === null || baseTip === null) return 'UNKNOWN';
      const baseOid = mergeBase(repo.objects, headTip, baseTip) ?? pull.mergeBaseSha;
      const merged = threeWayMerge(repo.objects, baseOid, headTip, baseTip);
      return merged.conflict || merged.treeOid === null ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (src) => (src as { pull: Pull }).pull.headRef,
    baseRefName: (src) => (src as { pull: Pull }).pull.baseRef,
    headRefOid: (src) => {
      const { repo, pull } = src as { repo: Repo; pull: Pull };
      return branchTip(repo, pull.headRef) ?? pull.headSha;
    },
    baseRefOid: (src) => {
      const { repo, pull } = src as { repo: Repo; pull: Pull };
      return branchTip(repo, pull.baseRef) ?? pull.baseSha;
    },
    url: (src) => {
      const { repo, pull } = src as { repo: Repo; pull: Pull };
      return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
    },
    createdAt: () => FIXED_ISO,
    updatedAt: () => FIXED_ISO,
    author: () => viewerView(),
    repository: (src) => repoView((src as { repo: Repo }).repo),
    files: (src, args) => {
      const { repo, pull } = src as { repo: Repo; pull: Pull };
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
        const changeType = change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED';
        return {
          __typename: 'PullRequestChangedFile',
          path: change.path,
          additions: counts.additions,
          deletions: counts.deletions,
          changeType,
        } as View;
      });
      const slice = sliceConnection(files, args, (file) => cursorOf((file as { path: string }).path));
      return {
        __typename: 'PullRequestChangedFileConnection',
        nodes: slice.nodes,
        totalCount: slice.totalCount,
        pageInfo: pageInfoFor(slice.totalCount, slice.start, slice.pageLength, (index) => cursorOf(files[index]!.path)),
      } as View;
    },
    labels: () => ({ __typename: 'LabelConnection', nodes: [], totalCount: 0, pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } }) as View,
    comments: () => ({ __typename: 'IssueCommentConnection', nodes: [], totalCount: 0, pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } }) as View,
    isDraft: () => false,
  },
  Label: {
    id: (src) => {
      const { repo, label } = src as { repo: Repo; label: { name: string; color: string } };
      return globalId('Label', `${repo.owner}/${repo.name}`, label.name);
    },
    name: (src) => (src as { label: { name: string } }).label.name,
    color: (src) => (src as { label: { color: string } }).label.color,
    description: () => null,
  },
  IssueComment: {
    id: (src) => {
      const { repo, issue, comment } = src as { repo: Repo; issue: Issue; comment: { id: number } };
      return globalId('IssueComment', `${repo.owner}/${repo.name}`, String(issue.number), String(comment.id));
    },
    databaseId: (src) => (src as { comment: { id: number } }).comment.id,
    body: (src) => (src as { comment: { body: string } }).comment.body,
    author: () => viewerView(),
    createdAt: () => FIXED_ISO,
    url: (src) => {
      const { repo, issue } = src as { repo: Repo; issue: Issue };
      return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${(src as { comment: { id: number } }).comment.id}`;
    },
  },
  IssueConnection: {
    nodes: (src) => (src as { nodes: View[] }).nodes,
    edges: (src) => (src as { nodes: View[] }).nodes.map((node) => ({ __typename: 'IssueEdge', node, cursor: cursorOf(nodeIdNumber(node)) }) as View),
    pageInfo: (src) => (src as { pageInfo: View }).pageInfo,
    totalCount: (src) => (src as { totalCount: number }).totalCount,
  },
  PullRequestConnection: {
    nodes: (src) => (src as { nodes: View[] }).nodes,
    edges: (src) => (src as { nodes: View[] }).nodes.map((node) => ({ __typename: 'PullRequestEdge', node, cursor: cursorOf(nodeIdNumber(node)) }) as View),
    pageInfo: (src) => (src as { pageInfo: View }).pageInfo,
    totalCount: (src) => (src as { totalCount: number }).totalCount,
  },
  IssueCommentConnection: {
    nodes: (src) => (src as { nodes: View[] }).nodes,
    edges: (src) => (src as { nodes: View[] }).nodes.map((node) => ({ __typename: 'IssueCommentEdge', node, cursor: cursorOf(nodeIdNumber(node)) }) as View),
    pageInfo: (src) => (src as { pageInfo: View }).pageInfo,
    totalCount: (src) => (src as { totalCount: number }).totalCount,
  },
  LabelConnection: {
    nodes: (src) => (src as { nodes: View[] }).nodes,
    edges: (src) => (src as { nodes: View[] }).nodes.map((node) => ({ __typename: 'LabelEdge', node, cursor: cursorOf(nodeIdName(node)) }) as View),
    pageInfo: (src) => (src as { pageInfo: View }).pageInfo,
    totalCount: (src) => (src as { totalCount: number }).totalCount,
  },
  PullRequestChangedFileConnection: {
    nodes: (src) => (src as { nodes: View[] }).nodes,
    edges: (src) => (src as { nodes: View[] }).nodes.map((node) => ({ __typename: 'PullRequestChangedFileEdge', node, cursor: cursorOf((node as { path: string }).path) }) as View),
    pageInfo: (src) => (src as { pageInfo: View }).pageInfo,
    totalCount: (src) => (src as { totalCount: number }).totalCount,
  },
  SearchResultItemConnection: {
    nodes: (src) => (src as { nodes: View[] }).nodes,
    edges: () => [],
    pageInfo: () => ({ __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }) as View,
    totalCount: (src) => (src as { totalCount: number }).totalCount,
  },
  IssueEdge: {
    node: (src) => (src as { node: View }).node,
    cursor: (src) => (src as { cursor: string }).cursor,
  },
  PullRequestEdge: {
    node: (src) => (src as { node: View }).node,
    cursor: (src) => (src as { cursor: string }).cursor,
  },
  IssueCommentEdge: {
    node: (src) => (src as { node: View }).node,
    cursor: (src) => (src as { cursor: string }).cursor,
  },
  LabelEdge: {
    node: (src) => (src as { node: View }).node,
    cursor: (src) => (src as { cursor: string }).cursor,
  },
  PullRequestChangedFileEdge: {
    node: (src) => (src as { node: View }).node,
    cursor: (src) => (src as { cursor: string }).cursor,
  },
  SearchResultItemEdge: {
    node: (src) => (src as { node: View }).node,
    cursor: (src) => (src as { cursor: string }).cursor,
  },
  PullRequestChangedFile: {
    path: (src) => (src as { path: string }).path,
    additions: (src) => (src as { additions: number }).additions,
    deletions: (src) => (src as { deletions: number }).deletions,
    changeType: (src) => (src as { changeType: string }).changeType,
  },
  PageInfo: {
    hasNextPage: (src) => (src as { hasNextPage: boolean }).hasNextPage,
    hasPreviousPage: (src) => (src as { hasPreviousPage: boolean }).hasPreviousPage,
    startCursor: (src) => (src as { startCursor: string | null }).startCursor,
    endCursor: (src) => (src as { endCursor: string | null }).endCursor,
  },
  CreateIssuePayload: {
    issue: (src) => (src as { issue: View | null }).issue,
    clientMutationId: (src) => (src as { clientMutationId: string | null }).clientMutationId,
  },
  CloseIssuePayload: {
    issue: (src) => (src as { issue: View | null }).issue,
    clientMutationId: (src) => (src as { clientMutationId: string | null }).clientMutationId,
  },
  CreatePullRequestPayload: {
    pullRequest: (src) => (src as { pullRequest: View | null }).pullRequest,
    clientMutationId: (src) => (src as { clientMutationId: string | null }).clientMutationId,
  },
  MergePullRequestPayload: {
    pullRequest: (src) => (src as { pullRequest: View | null }).pullRequest,
    clientMutationId: (src) => (src as { clientMutationId: string | null }).clientMutationId,
  },
  AddCommentPayload: {
    commentEdge: (src) => (src as { commentEdge: View | null }).commentEdge,
    clientMutationId: (src) => (src as { clientMutationId: string | null }).clientMutationId,
  },
  __Type: {
    name: (src) => (src as { name: string }).name,
    kind: (src) => (src as { kind: string }).kind,
    description: () => null,
    fields: (src) => {
      const fieldNames = (src as { fieldNames: string[] | null }).fieldNames;
      if (fieldNames === null) return null;
      return fieldNames.map((name) => ({ __typename: '__Field', name, typeName: typeNameOfField((src as { name: string }).name, name) }) as View);
    },
    enumValues: (src) => {
      const values = (src as { enumValues: string[] | null }).enumValues;
      if (values === null) return null;
      return values.map((name) => ({ __typename: '__EnumValue', name }) as View);
    },
    inputFields: () => null,
  },
  __Field: {
    name: (src) => (src as { name: string }).name,
    description: () => null,
    type: (src) => ({ __typename: '__Type', name: (src as { typeName: string }).typeName, kind: kindOfType((src as { typeName: string }).typeName), fieldNames: null, enumValues: null }) as View,
    args: () => [],
  },
  __EnumValue: {
    name: (src) => (src as { name: string }).name,
    description: () => null,
  },
  __InputValue: {
    name: (src) => (src as { name: string }).name,
    description: () => null,
    type: () => null,
    defaultValue: () => null,
  },
  __Schema: {
    types: () => Object.keys(SCHEMA).map((name) => typeView(name)).filter((view): view is View => view !== null),
    queryType: () => typeView('Query'),
    mutationType: () => typeView('Mutation'),
    description: () => null,
  },
};

function typeNameOfField(typeName: string, fieldName: string): string {
  return baseType(SCHEMA[typeName]?.[fieldName]?.type ?? 'String');
}

function kindOfType(typeName: string): string {
  if (ENUMS[typeName] !== undefined) return 'ENUM';
  if (SCALARS.has(typeName)) return 'SCALAR';
  return 'OBJECT';
}

function typeView(name: string): View | null {
  if (SCHEMA[name] !== undefined) {
    return { __typename: '__Type', name, kind: 'OBJECT', fieldNames: Object.keys(SCHEMA[name]!), enumValues: null };
  }
  if (ENUMS[name] !== undefined) {
    return { __typename: '__Type', name, kind: 'ENUM', fieldNames: null, enumValues: ENUMS[name] };
  }
  if (SCALARS.has(name)) {
    return { __typename: '__Type', name, kind: 'SCALAR', fieldNames: null, enumValues: null };
  }
  return null;
}

function viewerViewFor(login: string): View {
  if (login === VIEWER.login) return viewerView();
  return { __typename: 'User', login, id: 0, name: login, email: '' };
}

function nodeIdOf(src: View): string | null {
  switch (src.__typename) {
    case 'User':
      return globalId('User', src.login);
    case 'Repository':
      return globalId('Repository', `${src.repo.owner}/${src.repo.name}`);
    case 'Issue':
      return globalId('Issue', `${src.repo.owner}/${src.repo.name}`, String(src.issue.number));
    case 'PullRequest':
      return globalId('PullRequest', `${src.repo.owner}/${src.repo.name}`, String(src.pull.number));
    case 'Label':
      return globalId('Label', `${src.repo.owner}/${src.repo.name}`, src.label.name);
    case 'IssueComment':
      return globalId('IssueComment', `${src.repo.owner}/${src.repo.name}`, String(src.issue.number), String(src.comment.id));
    default:
      return null;
  }
}

function nodeIdNumber(node: View): number {
  if (node.__typename === 'Issue') return node.issue.number;
  if (node.__typename === 'PullRequest') return node.pull.number;
  if (node.__typename === 'IssueComment') return node.comment.id;
  return 0;
}

function nodeIdName(node: View): string {
  if (node.__typename === 'Label') return node.label.name;
  return '';
}

function resolveNode(id: string, ctx: Ctx): View | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const [ownerName, second, third] = decoded.parts;
  const [owner, name] = (ownerName ?? '').split('/');
  if (decoded.kind === 'User') return viewerViewFor(ownerName ?? '');
  const repo = ctx.store.getRepo(owner ?? '', name ?? '');
  if (repo === undefined) return null;
  if (decoded.kind === 'Repository') return repoView(repo);
  if (decoded.kind === 'Issue') {
    const issue = repo.issues.find((entry) => entry.number === Number.parseInt(second ?? '', 10));
    return issue === undefined ? null : issueView(repo, issue);
  }
  if (decoded.kind === 'PullRequest') {
    const pull = repo.pulls.find((entry) => entry.number === Number.parseInt(second ?? '', 10));
    return pull === undefined ? null : pullView(repo, pull);
  }
  if (decoded.kind === 'Label') {
    const label = repo.labels.find((entry) => entry.name === second);
    return label === undefined ? null : ({ __typename: 'Label', repo, label } as View);
  }
  if (decoded.kind === 'IssueComment') {
    const issue = repo.issues.find((entry) => entry.number === Number.parseInt(second ?? '', 10));
    const comment = issue?.comments.find((entry) => entry.id === Number.parseInt(third ?? '', 10));
    if (issue === undefined || comment === undefined) return null;
    return { __typename: 'IssueComment', repo, issue, comment } as View;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation: the whole document is checked against the schema before any
// field executes, so a mutation never runs with an unknown field in it.
// ---------------------------------------------------------------------------

function validateSelections(
  selections: SelectionNode[],
  typeName: string,
  fragments: Map<string, FragmentDef>,
  errors: string[],
): void {
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      if (selection.name !== null) {
        const fragment = fragments.get(selection.name);
        if (fragment === undefined) {
          errors.push(`Unknown fragment "${selection.name}".`);
        } else {
          validateSelections(fragment.selections, fragment.typeCondition, fragments, errors);
        }
      } else if (selection.typeCondition !== null) {
        validateSelections(selection.selections, selection.typeCondition, fragments, errors);
      } else {
        validateSelections(selection.selections, typeName, fragments, errors);
      }
      continue;
    }
    if (selection.name === '__typename') continue;
    const def = SCHEMA[typeName]?.[selection.name];
    if (def === undefined) {
      errors.push(`Cannot query field "${selection.name}" on type "${typeName}".`);
      continue;
    }
    if (selection.selections !== null) {
      if (isScalarType(def.type)) {
        errors.push(`Field "${selection.name}" must not have a selection since type "${baseType(def.type)}" has no subfields.`);
      } else {
        validateSelections(selection.selections, baseType(def.type), fragments, errors);
      }
    } else if (!isScalarType(def.type)) {
      errors.push(`Field "${selection.name}" of type "${def.type}" must have a selection of subfields.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

function executeSelections(
  selections: SelectionNode[],
  typeName: string,
  source: View,
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentDef>,
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      if (selection.name !== null) {
        const fragment = fragments.get(selection.name);
        if (fragment === undefined) continue;
        if (fragment.typeCondition !== source.__typename && fragment.typeCondition !== typeName) continue;
        Object.assign(out, executeSelections(fragment.selections, fragment.typeCondition, source, variables, fragments, ctx));
      } else if (selection.typeCondition !== null) {
        if (selection.typeCondition !== source.__typename && selection.typeCondition !== typeName) continue;
        Object.assign(out, executeSelections(selection.selections, selection.typeCondition, source, variables, fragments, ctx));
      } else {
        Object.assign(out, executeSelections(selection.selections, typeName, source, variables, fragments, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = source.__typename;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[selection.name] ?? RESOLVERS[source.__typename]?.[selection.name];
    if (resolver === undefined) {
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of Object.entries(selection.args)) {
      args[argName] = resolveValue(argValue, variables);
    }
    const value = resolver(source, args, ctx);
    if (selection.selections === null || value === null || value === undefined) {
      out[key] = value === undefined ? null : value;
      continue;
    }
    const def = SCHEMA[typeName]?.[selection.name] ?? SCHEMA[source.__typename]?.[selection.name];
    const childType = def === undefined ? source.__typename : baseType(def.type);
    if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item !== null && typeof item === 'object' && '__typename' in item
          ? executeSelections(selection.selections!, childType, item as View, variables, fragments, ctx)
          : item,
      );
    } else if (typeof value === 'object' && '__typename' in value) {
      out[key] = executeSelections(selection.selections!, childType, value as View, variables, fragments, ctx);
    } else {
      out[key] = value;
    }
  }
  return out;
}

interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

function executeOperation(
  operation: Operation,
  variables: Record<string, unknown>,
  fragments: Map<string, FragmentDef>,
  ctx: Ctx,
): GraphQLResult {
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const mergedVariables: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(operation.variables)) {
    if (variables[name] !== undefined) mergedVariables[name] = variables[name];
    else if (def.defaultValue !== undefined) mergedVariables[name] = resolveValue(def.defaultValue, variables);
    else mergedVariables[name] = null;
  }
  for (const [name, value] of Object.entries(variables)) {
    if (!(name in mergedVariables)) mergedVariables[name] = value;
  }
  const errors: string[] = [];
  validateSelections(operation.selections, rootType, fragments, errors);
  for (const fragment of fragments.values()) {
    validateSelections(fragment.selections, fragment.typeCondition, fragments, errors);
  }
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  try {
    const root = { __typename: rootType } as View;
    const data = executeSelections(operation.selections, rootType, root, mergedVariables, fragments, ctx);
    return { data };
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

// ---------------------------------------------------------------------------
// HTTP entry point.
// ---------------------------------------------------------------------------

export function handleGraphQL(body: Buffer, store: ForgeStore, res: ServerResponse): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { errors: [{ message: 'malformed JSON body' }] });
    return;
  }
  const ctx: Ctx = { store };
  const requests = Array.isArray(parsed) ? parsed : [parsed];
  const results: GraphQLResult[] = [];
  for (const request of requests) {
    if (!isRecord(request) || typeof request.query !== 'string') {
      results.push({ data: null, errors: [{ message: 'query is required' }] });
      continue;
    }
    let doc: Document;
    try {
      doc = new Parser(request.query).parseDocument();
    } catch (err) {
      results.push({ data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] });
      continue;
    }
    const variables = isRecord(request.variables) ? (request.variables as Record<string, unknown>) : {};
    let operation = doc.operations[0];
    if (typeof request.operationName === 'string') {
      operation = doc.operations.find((entry) => entry.name === request.operationName) ?? operation;
    }
    if (operation === undefined) {
      results.push({ data: null, errors: [{ message: 'no operation in document' }] });
      continue;
    }
    results.push(executeOperation(operation, variables, doc.fragments, ctx));
  }
  sendJson(res, 200, Array.isArray(parsed) ? results : results[0]);
}
