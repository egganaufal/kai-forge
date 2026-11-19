// Small shared helpers for the HTTP surfaces: JSON answers, request ids,
// pagination links and base64.

import type { ServerResponse } from 'node:http';

let requestCounter = 0;

/** A deterministic, unique-per-process request id (no randomness, no clock). */
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...extraHeaders,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'x-github-request-id': nextRequestId() });
  res.end();
}

/** Parse a JSON body; returns `{ ok: false }` when the bytes are not JSON. */
export function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

export interface PageParams {
  page: number;
  perPage: number;
}

export function pageParams(query: URLSearchParams): PageParams {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const rawPerPage = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(rawPerPage) ? Math.min(100, Math.max(1, rawPerPage)) : 30;
  return { page, perPage };
}

/** Slice one page out of `items` (in order) and build GitHub's Link header. */
export function paginate<T>(
  items: readonly T[],
  query: URLSearchParams,
  baseUrl: string,
  path: string,
): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(query);
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const other = new URLSearchParams(query);
  other.set('per_page', String(perPage));
  const urlFor = (p: number): string => {
    const params = new URLSearchParams(other);
    params.set('page', String(p));
    return `${baseUrl}${path}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(totalPages)}>; rel="last"`);
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}
