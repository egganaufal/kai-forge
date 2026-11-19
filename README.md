# Kai Forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/egganaufal/kai-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/egganaufal/kai-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, single-process GitHub-compatible git forge written in Node 22
with only the standard library. No dependencies, no git binary, no network
beyond the scoring environment.

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git`: `info/refs`, `git-upload-pack`
  (protocol v2: `ls-refs`, `fetch`, shallow/deepen) and `git-receive-pack`
  (protocol v0 with `report-status` and `side-band-64k`). Real git objects
  with SHA-1 ids, packfiles, fast-forward-only pushes with per-ref reports.
- **REST v3** under `/api/v3`: repositories, branches, commits, contents,
  labels, issues, comments, pull requests, files and squash merges, with
  GitHub-shaped JSON, pagination `Link` headers and `X-GitHub-Request-Id`.
- **GraphQL v4** at `/api/graphql`: the documents `gh` and
  `github-mcp-server` send — viewer, repository, issues, pull requests,
  mutations, `node(id:)`, introspection and batched operations.
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP, legacy handshake
  (`initialize`, `tools/list`, `tools/call`) with the six repository tools.

## Run it

```sh
node main.ts
```

The process binds an ephemeral port, registers it at
`$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until the
environment says the trial is over and exits 0. `MAKEFUN_SHOP_TOKEN` is the
bearer token the API surfaces accept.

All state lives in memory. Nothing is written to disk, and no timestamp,
random value or wall-clock reading ever enters stored state, so a replayed
trial produces identical bytes.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bgcz4w0h&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
