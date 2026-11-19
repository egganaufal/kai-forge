// HTTP front door: routing, body reading, the bearer-token gate, and the
// X-GitHub-Request-Id header on every reply.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ForgeStore } from './store.ts';
import { handleRest, type RestArgs } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { nextRequestId, parseJsonBody, sendError, sendJson } from './util.ts';

const MAX_BODY = 64 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  const envToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (envToken === '') return true;
  return token === envToken;
}

function decodeSegments(pathname: string): string[] | null {
  const parts = pathname.split('/').filter((part) => part !== '');
  const out: string[] = [];
  for (const part of parts) {
    try {
      out.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return out;
}

export function createApp(): Server {
  const store = new ForgeStore();
  return createServer((req, res) => {
    void (async () => {
      try {
        await dispatch(req, res, store);
      } catch (err) {
        if (!res.headersSent) {
          sendError(res, 500, err instanceof Error ? err.message : 'internal error');
        } else {
          res.destroy();
        }
      }
    })();
  });
}

async function dispatch(req: IncomingMessage, res: ServerResponse, store: ForgeStore): Promise<void> {
  const method = req.method ?? 'GET';
  // Every reply carries a request id, including the git surfaces.
  res.setHeader('x-github-request-id', nextRequestId());
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
  const segments = decodeSegments(url.pathname);
  if (segments === null) {
    sendError(res, 400, 'malformed URL');
    return;
  }

  // Health check: the environment's boot probe.
  if (segments.length === 1 && segments[0] === 'healthz') {
    if (method !== 'GET') {
      sendError(res, 405, 'method not allowed');
      return;
    }
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  // GraphQL.
  if (url.pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendError(res, 405, 'method not allowed');
      return;
    }
    if (!authorized(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    const body = await readBody(req);
    handleGraphQL(body, store, res);
    return;
  }

  // MCP.
  if (url.pathname === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(200, { 'x-github-request-id': nextRequestId() });
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendError(res, 405, 'method not allowed');
      return;
    }
    if (!authorized(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    const body = await readBody(req);
    handleMcp(body, store, res);
    return;
  }

  // REST v3.
  if (segments.length >= 1 && segments[0] === 'api' && segments[1] === 'v3') {
    const restSegments = segments.slice(2);
    const isPublic = restSegments.length === 0 || (restSegments.length === 1 && restSegments[0] === 'meta');
    if (!isPublic && !authorized(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
    const parsed = parseJsonBody(body);
    const args: RestArgs = {
      store,
      method,
      segments: restSegments,
      query: url.searchParams,
      body,
      json: parsed.ok ? parsed.value : undefined,
      jsonError: !parsed.ok,
      baseUrl: `http://${req.headers.host ?? '127.0.0.1'}`,
    };
    const handled = handleRest(args, res);
    if (!handled) sendError(res, 404, 'Not Found');
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    const owner = segments[0]!;
    const repoName = segments[1]!.slice(0, -'.git'.length);
    const repo = store.getRepo(owner, repoName);
    const tail = segments.slice(2);
    if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && method === 'GET') {
      handleInfoRefs(req, res, repo, url.searchParams.get('service') ?? '');
      return;
    }
    if (tail.length === 1 && tail[0] === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      handleUploadPack(req, res, repo, body);
      return;
    }
    if (tail.length === 1 && tail[0] === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      handleReceivePack(req, res, repo, body);
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  sendError(res, 404, 'Not Found');
}
