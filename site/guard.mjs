import { inflateRawSync } from 'node:zlib';

/**
 * The site is public, so a download must never carry addresses or secrets from someone's home.
 * Each pattern is something that has no business inside a published file.
 */
export const PRIVATE_PATTERNS = [
  ['home server hostname', /barkhaus[a-z0-9]*/i],
  ['Tailscale address', /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/],
  ['Tailscale name', /[a-z0-9-]+\.ts\.net\b/i],
  ['home directory', /\/home\/(?!user\b)[a-z][a-z0-9_-]+\/|[A-Z]:\\Users\\[A-Za-z]/],
  ['API token', /SENSEI_(?:API_TOKEN|JIMAKU_API_KEY)\s*=\s*["']?[A-Za-z0-9_-]{16,}/],
];

/** Reads every file in a zip (stored or deflated). Enough for the archives we publish. */
export function* zipEntries(buf) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error('not a zip file');
  let p = buf.readUInt32LE(end + 16);
  for (let n = buf.readUInt16LE(end + 10); n > 0; n--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('broken zip directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + size);
    if (!name.endsWith('/')) {
      if (method !== 0 && method !== 8) throw new Error(`cannot check ${name}: zip method ${method}`);
      yield [name, method === 8 ? inflateRawSync(raw) : raw];
    }
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
}

export function findPrivate(buf) {
  const hits = [];
  for (const [name, data] of zipEntries(buf)) {
    if (/(^|\/)\.env$/.test(name)) hits.push(`${name}: environment file`);
    const text = data.toString('latin1');
    for (const [what, re] of PRIVATE_PATTERNS) if (re.test(text)) hits.push(`${name}: ${what}`);
  }
  return hits;
}

export function assertPublishable(file, buf) {
  const hits = findPrivate(buf);
  if (hits.length) throw new Error(`Refusing to publish ${file}:\n  ${hits.join('\n  ')}`);
}
