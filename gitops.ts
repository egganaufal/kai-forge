// Git object machinery: SHA-1 ids, tree/commit/tag codecs, reachability walks,
// tree surgery for the contents API, three-way merges, and packfile read/write.
// Written from the git object format itself; no git binary anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType } from './store.ts';

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

/** Store an object in a repo's map and answer its id (no-op when already held). */
export function putObject(objects: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// -------------------------------------------------------------------------------------------
// trees
// -------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function treeSortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// commits and tags
// -------------------------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's bytes. The message is stored with one trailing newline, git's way. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const stamp = `${fields.timestamp} +0000`;
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${stamp}`, `committer ${fields.committer} ${stamp}`, '');
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const type = headers.get('type') ?? '';
  return {
    object: headers.get('object') ?? '',
    type: type === 'commit' || type === 'tree' || type === 'blob' || type === 'tag' ? type : 'commit',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** The target a tag object (or a ref pointing at one) peels to, following tag chains. */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const object = objects.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// reachability
// -------------------------------------------------------------------------------------------

/** Every object reachable from `roots`, following commits, trees and tags. */
export function collectReachable(
  objects: Map<string, GitObject>,
  roots: Iterable<string>,
  allowMissing = false,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) {
      if (allowMissing) continue;
      throw new Error(`object ${oid} is missing`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/**
 * Like collectReachable, but a commit listed in `shallow` contributes itself
 * and its tree only: a shallow clone holds the boundary commit, not its
 * ancestors, so a deepen must still deliver them.
 */
export function collectReachableBounded(
  objects: Map<string, GitObject>,
  roots: Iterable<string>,
  shallow: ReadonlySet<string>,
  allowMissing = false,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) {
      if (allowMissing) continue;
      throw new Error(`object ${oid} is missing`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      if (!shallow.has(oid)) {
        for (const parent of commit.parents) queue.push(parent);
      }
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` (or they are the same commit). */export function isAncestor(objects: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits: the first shared commit found walking from `b`. */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.pop()!;
    if (ancestorsA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// path surgery on trees
// -------------------------------------------------------------------------------------------

/** The tree entry at `segments` below `treeOid`, or null when the path is absent. */
export function treeEntryAt(
  objects: Map<string, GitObject>,
  treeOid: string,
  segments: readonly string[],
): TreeEntry | null {
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const tree = objects.get(current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The blob a commit's tree holds at `path`, or null. */
export function readPath(
  objects: Map<string, GitObject>,
  commitOid: string,
  path: string,
): { oid: string; data: Buffer } | null {
  const commit = objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) return null;
  const entry = treeEntryAt(objects, parseCommit(commit.data).tree, segments);
  if (entry === null || entry.mode === '40000') return null;
  const blob = objects.get(entry.oid);
  if (blob === undefined || blob.type !== 'blob') return null;
  return { oid: entry.oid, data: blob.data };
}

/** The entries of the directory at `path` in a commit's tree (`''` is the root), or null. */
export function listPath(
  objects: Map<string, GitObject>,
  commitOid: string,
  path: string,
): TreeEntry[] | null {
  const commit = objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return null;
  const root = parseCommit(commit.data).tree;
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) {
    const tree = objects.get(root);
    return tree !== undefined && tree.type === 'tree' ? parseTree(tree.data) : null;
  }
  const entry = treeEntryAt(objects, root, segments);
  if (entry === null || entry.mode !== '40000') return null;
  const tree = objects.get(entry.oid);
  return tree !== undefined && tree.type === 'tree' ? parseTree(tree.data) : null;
}

function putTree(objects: Map<string, GitObject>, entries: TreeEntry[]): string {
  return putObject(objects, 'tree', buildTree(entries));
}

/**
 * A root tree with `segments` set to `newOid` (or removed when null), storing every
 * intermediate tree it builds. Empty directories left behind by a removal are pruned.
 */
export function updateTree(
  objects: Map<string, GitObject>,
  rootTreeOid: string | null,
  segments: readonly string[],
  newOid: string | null,
): string {
  if (segments.length === 0) return rootTreeOid ?? putTree(objects, []);
  const head = segments[0]!;
  const rest = segments.slice(1);
  const current = rootTreeOid === null ? [] : parseTree(objects.get(rootTreeOid)?.data ?? Buffer.alloc(0));
  const kept = current.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (newOid !== null) kept.push({ mode: '100644', name: head, oid: newOid });
    return putTree(objects, kept);
  }
  const existing = current.find((entry) => entry.name === head && entry.mode === '40000');
  const childOid = updateTree(objects, existing?.oid ?? null, rest, newOid);
  const child = objects.get(childOid);
  const childEntries = child !== undefined && child.type === 'tree' ? parseTree(child.data) : [];
  if (childEntries.length === 0) return putTree(objects, kept);
  kept.push({ mode: '40000', name: head, oid: childOid });
  return putTree(objects, kept);
}

// -------------------------------------------------------------------------------------------
// diffs and merges
// -------------------------------------------------------------------------------------------

export interface DiffEntry {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
}

function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix: string, out: Map<string, string>): void {
  const tree = objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(objects, entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, entry.oid);
  }
}

/** The file-level difference between two trees (either may be null for empty). */
export function diffTrees(
  objects: Map<string, GitObject>,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): DiffEntry[] {
  const base = new Map<string, string>();
  const head = new Map<string, string>();
  if (baseTreeOid !== null) flattenTree(objects, baseTreeOid, '', base);
  if (headTreeOid !== null) flattenTree(objects, headTreeOid, '', head);
  const out: DiffEntry[] = [];
  for (const [path, oid] of head) {
    const old = base.get(path);
    if (old === undefined) out.push({ path, status: 'added', oldOid: null, newOid: oid });
    else if (old !== oid) out.push({ path, status: 'modified', oldOid: old, newOid: oid });
  }
  for (const [path, oid] of base) {
    if (!head.has(path)) out.push({ path, status: 'removed', oldOid: oid, newOid: null });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** A line-count difference between two text blobs, by common prefix/suffix trimming. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const splitLines = (text: string): string[] => {
    if (text === '') return [];
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { additions: newLines.length - prefix - suffix, deletions: oldLines.length - prefix - suffix };
}

export interface MergeResult {
  conflict: boolean;
  treeOid: string | null;
}

/**
 * A three-way squash merge of `headTip` into `baseTip`, both descended from `baseOid`.
 * A path changed on both sides with different results is a conflict; otherwise the
 * head side's changes win and the merged tree is returned.
 */
export function threeWayMerge(
  objects: Map<string, GitObject>,
  baseOid: string,
  headTip: string,
  baseTip: string,
): MergeResult {
  const treeOf = (oid: string): string | null => {
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  };
  const baseTree = treeOf(baseOid);
  const headTree = treeOf(headTip);
  const tipTree = treeOf(baseTip);
  const headChanges = diffTrees(objects, baseTree, headTree);
  const tipChanges = diffTrees(objects, baseTree, tipTree);
  const tipByPath = new Map(tipChanges.map((change) => [change.path, change]));
  for (const change of headChanges) {
    const other = tipByPath.get(change.path);
    if (other !== undefined && other.newOid !== change.newOid) return { conflict: true, treeOid: null };
  }
  let merged = tipTree;
  for (const change of headChanges) {
    merged = updateTree(objects, merged, change.path.split('/'), change.newOid);
  }
  return { conflict: false, treeOid: merged };
}

// -------------------------------------------------------------------------------------------
// packfiles (plain objects only; the suite's client never writes deltas)
// -------------------------------------------------------------------------------------------

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 packfile from plain objects, with its SHA-1 trailer. */
export function writePack(objects: Iterable<{ type: GitObjectType; data: Buffer }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readPackVarint(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset]!;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

/**
 * Read a packfile into objects keyed by id. Verifies the trailer checksum and
 * every entry's inflated size; delta entries are rejected (never sent here).
 */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  const out = new Map<string, GitObject>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const header = readPackVarint(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    if (typeCode === 6 || typeCode === 7) throw new Error('delta pack entries are not supported');
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`pack entry has unknown type code ${typeCode}`);
    const inflated = inflateSync(pack.subarray(offset, trailerStart), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== header.size) throw new Error('pack entry inflated to the wrong size');
    offset += inflated.engine.bytesWritten;
    out.set(hashObject(type, inflated.buffer), { type, data: inflated.buffer });
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');
  return out;
}

// -------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------

/** Encode one data packet: 4 hex length bytes, then the payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > 65520) throw new Error('pkt-line payload is too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Decode a whole buffer of pkt-lines into data payloads and control markers. */
export function decodePktLines(buffer: Buffer): Array<{ kind: 'data' | 'flush' | 'delim' | 'response-end'; payload?: Buffer }> {
  const out: Array<{ kind: 'data' | 'flush' | 'delim' | 'response-end'; payload?: Buffer }> = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      out.push({ kind: 'response-end' });
      offset += 4;
    } else if (length < 4 || length > 65520 || offset + length > buffer.length) {
      throw new Error('malformed pkt-line');
    } else {
      out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return out;
}
