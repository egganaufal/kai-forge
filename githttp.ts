// Git smart HTTP: info/refs advertisements, protocol-v2 upload-pack
// (ls-refs, fetch, shallow/deepen) and v0 receive-pack with report-status.
// Framing follows the pkt-line codec in gitops.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ForgeStore, GitObject, Repo } from './store.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  collectReachable,
  collectReachableBounded,
  decodePktLines,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  pktLine,
  readPack,
  writePack,
} from './gitops.ts';

const AGENT = 'kai-forge/1.0';

export interface GitContext {
  store: ForgeStore;
}

/** The ref list a repo advertises, sorted; HEAD resolves to the default branch. */
function advertisedRefs(repo: Repo): Array<{ oid: string; name: string }> {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ oid, name }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function headOid(repo: Repo): string | null {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip !== undefined) return tip;
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/heads/')) return oid;
  }
  return null;
}

/** The capabilities line of a v0 advertisement, NUL-separated from the first ref. */
function v0Capabilities(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): string {
  const head = headOid(repo);
  const symref = head !== null ? `symref=HEAD:refs/heads/${repo.defaultBranch} ` : '';
  if (service === 'git-upload-pack') {
    return `${symref}side-band-64k multi_ack thin-pack ofs-delta shallow agent=${AGENT}`;
  }
  return `${symref}report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
}

/** A v0 ref advertisement: service preamble, ref lines, peeled tags, flush. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps = v0Capabilities(repo, service);
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${caps}\n`));
  } else {
    const head = headOid(repo);
    let first = true;
    if (head !== null) {
      parts.push(pktLine(`${head} HEAD\u0000${caps}\n`));
      first = false;
    }
    for (const ref of refs) {
      const line = first ? `${ref.oid} ${ref.name}\u0000${caps}\n` : `${ref.oid} ${ref.name}\n`;
      first = false;
      parts.push(pktLine(line));
      const peeled = peelToCommit(repo.objects, ref.oid);
      if (peeled !== null && peeled !== ref.oid && repo.objects.get(ref.oid)?.type === 'tag') {
        parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A protocol-v2 capability advertisement. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// -------------------------------------------------------------------------------------------
// info/refs
// -------------------------------------------------------------------------------------------

export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo | undefined,
  service: string,
): void {
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'unknown service' }));
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
  res.writeHead(200, {
    'content-type': `application/x-${service}-advertisement`,
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const depth = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(depth)) args.depth = depth;
    }
  }
  return args;
}

/** The objects a fetch must send, and the shallow boundary it reports. */
function computeFetch(
  repo: Repo,
  args: FetchArgs,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const haveReachable = collectReachableBounded(repo.objects, args.haves, new Set(args.shallow), true);
  const peeledWants = args.wants.map((want) => {
    const object = repo.objects.get(want);
    if (object !== undefined && object.type === 'tag') return parseTag(object.data).object;
    return want;
  });
  if (args.depth === undefined) {
    const wanted = collectReachable(repo.objects, args.wants, true);
    const send: GitObject[] = [];
    for (const oid of wanted) {
      if (haveReachable.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object !== undefined) send.push(object);
    }
    return { objects: send, shallow: [], unshallow: [] };
  }
  // Depth-limited: generation 0 is the wanted tip, generation n its nth ancestors.
  // Only the included commits and their tree closures travel; parents past the
  // cutoff are never followed, so a shallow fetch stays shallow.
  const generation = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = peeledWants.map((oid) => ({ oid, gen: 0 }));
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (gen >= args.depth || generation.has(oid)) continue;
    generation.set(oid, gen);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
  }
  const included = [...generation.keys()];
  const sendSet = new Set<string>();
  const walkTree = (treeOid: string): void => {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    sendSet.add(treeOid);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000') walkTree(entry.oid);
      else if (entry.mode !== '160000') sendSet.add(entry.oid);
    }
  };
  for (const oid of included) {
    sendSet.add(oid);
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'commit') walkTree(parseCommit(object.data).tree);
    else if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') {
        sendSet.add(target);
        walkTree(parseCommit(targetObject.data).tree);
      }
    }
  }
  const send: GitObject[] = [];
  for (const oid of sendSet) {
    if (haveReachable.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) send.push(object);
  }
  // Tag objects named by the wants ride along whole.
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (object !== undefined && object.type === 'tag' && !haveReachable.has(want) && !sendSet.has(want)) {
      send.push(object);
    }
  }
  const shallow: string[] = [];
  for (const [oid, gen] of generation) {
    if (gen === args.depth - 1) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const old of args.shallow) {
    if (!generation.has(old)) continue;
    const object = repo.objects.get(old);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => generation.has(parent))) unshallow.push(old);
  }
  return { objects: send, shallow, unshallow };
}

/** Sideband-64k framing: band 1 carries the pack, chunked under the pkt-line cap. */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

function sendPackResult(res: ServerResponse, body: Buffer): void {
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

export function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo | undefined,
  body: Buffer,
): void {
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'malformed pkt-line stream' }));
    return;
  }
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') lines.push('');
    else if (packet.kind === 'data' && packet.payload !== undefined) lines.push(packet.payload.toString('utf8'));
  }
  const first = (lines[0] ?? '').replace(/\n$/, '');
  if (first.startsWith('command=ls-refs')) {
    handleLsRefs(res, repo, lines);
    return;
  }
  if (first.startsWith('command=fetch')) {
    handleFetchV2(res, repo, lines);
    return;
  }
  // A v0 fetch: want/have/done lines in two flush-separated sections.
  if (first.startsWith('want ')) {
    handleFetchV0(res, repo, lines);
    return;
  }
  res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ message: 'unknown git-upload-pack command' }));
}

function handleLsRefs(res: ServerResponse, repo: Repo, lines: string[]): void {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let pastDelim = false;
  for (const line of lines) {
    const text = line.replace(/\n$/, '');
    if (text === 'command=ls-refs') continue;
    if (text === '') {
      pastDelim = true;
      continue;
    }
    if (!pastDelim) continue;
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const refs = advertisedRefs(repo);
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (refs.length === 0) {
    if (unborn && keep('HEAD')) {
      const attrs = symrefs ? ' symref-target:refs/heads/main' : '';
      parts.push(pktLine(`unborn HEAD${attrs}\n`));
    }
  } else {
    if (prefixes.length === 0) {
      const head = headOid(repo);
      if (head !== null) {
        const attrs = symrefs ? ' symref-target:refs/heads/main' : '';
        parts.push(pktLine(`${head} HEAD${attrs}\n`));
      }
    }
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel && repo.objects.get(ref.oid)?.type === 'tag') {
        const peeled = peelToCommit(repo.objects, ref.oid);
        if (peeled !== null && peeled !== ref.oid) line += ` peeled:${peeled}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  const body = Buffer.concat(parts);
  res.writeHead(200, {
    'content-type': 'application/x-git-upload-pack-result',
    'content-length': body.length,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function handleFetchV2(res: ServerResponse, repo: Repo, lines: string[]): void {
  const args = parseFetchArgs(lines);
  const { objects, shallow, unshallow } = computeFetch(repo, args);
  const pack = writePack(objects.map((object) => ({ type: object.type, data: object.data })));
  const parts: Buffer[] = [pktLine('acknowledgments\n')];
  let acked = false;
  for (const have of args.haves) {
    if (repo.objects.has(have)) {
      parts.push(pktLine(`ACK ${have}\n`));
      acked = true;
    }
  }
  if (!acked) parts.push(pktLine('NAK\n'));
  parts.push(pktLine('ready\n'), PKT_DELIM);
  if (args.depth !== undefined) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  sendPackResult(res, Buffer.concat(parts));
}

function handleFetchV0(res: ServerResponse, repo: Repo, lines: string[]): void {
  const args = parseFetchArgs(lines);
  const { objects, shallow, unshallow } = computeFetch(repo, args);
  const pack = writePack(objects.map((object) => ({ type: object.type, data: object.data })));
  const parts: Buffer[] = [];
  let acked = false;
  for (const have of args.haves) {
    if (repo.objects.has(have)) {
      parts.push(pktLine(`ACK ${have}\n`));
      acked = true;
    }
  }
  if (!acked) parts.push(pktLine('NAK\n'));
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  sendPackResult(res, Buffer.concat(parts));
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo | undefined,
  body: Buffer,
): void {
  if (repo === undefined) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }
  // The command list is pkt-lined up to the first flush; the pack follows raw.
  let flushAt = -1;
  {
    let offset = 0;
    while (offset + 4 <= body.length) {
      const header = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
      const length = Number.parseInt(header, 16);
      if (length === 0) {
        flushAt = offset + 4;
        break;
      }
      if (length < 4 || offset + length > body.length) break;
      offset += length;
    }
  }
  if (flushAt < 0) {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'malformed pkt-line stream' }));
    return;
  }
  let commandPackets;
  try {
    commandPackets = decodePktLines(body.subarray(0, flushAt));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'malformed pkt-line stream' }));
    return;
  }
  const commands: PushCommand[] = [];
  for (const packet of commandPackets) {
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\u0000');
    if (nul >= 0) text = text.slice(0, nul);
    const parts = text.split(' ');
    if (parts.length < 3 || !isOid(parts[0]!) || !isOid(parts[1]!)) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  const packBytes = body.subarray(flushAt);
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const packed = readPack(packBytes);
      for (const [oid, object] of packed) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.oldOid === ZERO_OID && command.newOid === ZERO_OID) {
        reportLines.push(`ng ${command.ref} invalid command`);
        continue;
      }
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) reportLines.push(`ng ${command.ref} reference does not exist`);
        else if (current !== command.oldOid) reportLines.push(`ng ${command.ref} non-fast-forward`);
        else {
          repo.refs.delete(command.ref);
          reportLines.push(`ok ${command.ref}`);
        }
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportLines.push(`ng ${command.ref} already exists`);
          continue;
        }
        if (!repo.objects.has(command.newOid)) {
          reportLines.push(`ng ${command.ref} missing object`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
        continue;
      }
      // Update.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} reference does not exist`);
        continue;
      }
      if (current !== command.oldOid) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        reportLines.push(`ng ${command.ref} missing object`);
        continue;
      }
      if (!isAncestor(repo.objects, command.oldOid, command.newOid)) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    }
  } else {
    for (const command of commands) reportLines.push(`ng ${command.ref} unpack failed`);
  }
  const parts: Buffer[] = [];
  const report = [`unpack ${unpackOk ? 'ok' : unpackDetail}`, ...reportLines];
  for (const line of report) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pktLine(`${line}\n`)])));
  }
  parts.push(PKT_FLUSH);
  const responseBody = Buffer.concat(parts);
  res.writeHead(200, {
    'content-type': 'application/x-git-receive-pack-result',
    'content-length': responseBody.length,
    'cache-control': 'no-cache',
  });
  res.end(responseBody);
}
