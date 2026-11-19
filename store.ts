// The forge's whole state: repositories, git objects, refs, issues, pulls.
// Everything lives in memory; nothing is ever written to disk, and no clock,
// random value or port ever enters stored state, so a replayed trial builds
// the same bytes.

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  /** Creation order inside the repository; the sort key for created asc/desc. */
  seq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  /** The merge-base the pull request was opened against, for files and merges. */
  mergeBaseSha: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Label[];
  issues: Issue[];
  pulls: Pull[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
}

/** The login the trial's bearer token names (the scenario's viewer). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The scenario's stranger login: a repository name under it is a 404. */
export const STRANGER_LOGIN = 'olgabauer';

/** The scenario's organisation login. */
export const ORG_LOGIN = 'faint-meadow-org';

/** The one fixed timestamp every server-made commit and record carries. */
export const FIXED_EPOCH_SEC = 1735689600; // 2025-01-01T00:00:00Z
export const FIXED_ISO = '2025-01-01T00:00:00Z';

/** The identity line server-made commits carry. */
export function serverIdentity(): string {
  return `${VIEWER.name} <${VIEWER.email}>`;
}

export class ForgeStore {
  readonly repos = new Map<string, Repo>();
  private nextId = 1;
  private nextSeq = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  nextDatabaseId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  nextSequence(): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return seq;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextDatabaseId(),
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      labels: [],
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      seq: this.nextSequence(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** Every repository the viewer owns, in creation order. */
  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER.login) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}
