/** Internal, single-operator archive. Never imports a paid generation provider. */
import { createHash } from 'node:crypto';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const MEDIA = new Map(Object.entries({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', srt: 'application/x-subrip' }));
const token = (s) => typeof s === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/.test(s);
const safePath = (s) => typeof s === 'string' && s.length > 0 && !s.startsWith('/') && !/[\\\u0000-\u001f]/.test(s) && !s.split('/').some(p => p === '.' || p === '..');

export function validateConfig(c) {
  if (!c || !token(c.owner) || !token(c.bucket) || c.bucket === 'videos') throw new Error('Dedicated archive bucket and owner namespace required');
  for (const k of ['maxObjectBytes', 'maxTransferBytes', 'maxLibraryBytes']) {
    if (!Number.isSafeInteger(c[k]) || c[k] <= 0) throw new Error(`Positive byte limit required: ${k}`);
  }
  if (c.maxObjectBytes > 256 * 1024 * 1024) throw new Error('Object limit exceeds 256 MiB bounded-memory limit');
  if (!Array.isArray(c.sources) || !c.sources.length) throw new Error('Explicit source scopes required');
  for (const s of c.sources) {
    if (!token(s.bucket) || s.bucket === c.bucket || !safePath(s.prefix) || !s.prefix.endsWith('/') || s.prefix.split('/').filter(Boolean).length < 2) throw new Error('Source must be a specific project prefix ending in /');
    if (!Array.isArray(s.tags) || s.tags.some(t => typeof t !== 'string' || t.length > 100) || typeof s.description !== 'string' || s.description.length > 1000) throw new Error('Description and tags required');
    if (c.sources.some(other => other !== s && other.bucket === s.bucket && s.prefix.startsWith(other.prefix))) throw new Error('Overlapping source scopes');
  }
  return c;
}

/** Stable pagination; errors fail closed, never masquerade as an empty bucket. */
export async function listFiles(port, bucket, prefix = '') {
  const queue = [prefix.replace(/\/$/, '')];
  const result = [];
  const visited = new Set();
  while (queue.length) {
    const dir = queue.shift();
    if (visited.has(dir)) throw new Error('Repeated directory');
    visited.add(dir);
    for (let offset = 0; ; offset += 100) {
      const page = await port.list(bucket, dir, offset, 100);
      if (!Array.isArray(page)) throw new Error('Invalid storage listing');
      for (const row of page) {
        if (typeof row.name !== 'string' || row.name.includes('/') || !safePath(row.name)) throw new Error('Invalid object name');
        const path = dir ? `${dir}/${row.name}` : row.name;
        if (row.id === null && row.metadata === null) queue.push(path);
        else {
          if (row.metadata?.size === null || row.metadata?.size === undefined) throw new Error(`Unknown object size: ${path}`);
          const size = Number(row.metadata.size);
          if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Unknown object size: ${path}`);
          result.push({ path, size, mime: row.metadata?.mimetype });
        }
      }
      if (page.length < 100) break;
      if (offset >= 100000) throw new Error('Listing safety limit exceeded');
    }
    if (visited.size > 10000) throw new Error('Directory safety limit exceeded');
  }
  return result;
}

export async function privateBucket(port, config, create = false) {
  let b = await port.bucket(config.bucket);
  if (!b && create) {
    await port.createBucket(config.bucket, config.maxObjectBytes);
    b = await port.bucket(config.bucket);
  }
  if (!b) throw new Error('Archive bucket missing: run init after capacity review');
  if (b.public !== false) throw new Error('Archive bucket must be private');
}

export async function planArchive(port, config) {
  validateConfig(config);
  await privateBucket(port, config);
  const existing = await listFiles(port, config.bucket);
  const usedBytes = existing.reduce((n, x) => n + x.size, 0);
  const files = [];
  for (const s of config.sources) {
    for (const f of await listFiles(port, s.bucket, s.prefix)) {
      const extension = f.path.split('.').at(-1).toLowerCase();
      if (!MEDIA.has(extension)) continue;
      if (f.size === 0 || f.size > config.maxObjectBytes) throw new Error(`Unsupported object size: ${f.path}`);
      files.push({ ...f, extension, source: s });
    }
  }
  const sourceBytes = files.reduce((n, f) => n + f.size, 0);
  // Conservative: existing objects may require readback too, and JSON records need space.
  const transferUpperBound = sourceBytes * 2;
  const addedUpperBound = sourceBytes + files.length * 16384;
  if (transferUpperBound > config.maxTransferBytes) throw new Error('Transfer budget exceeded');
  if (usedBytes + addedUpperBound > config.maxLibraryBytes) throw new Error('Archive byte budget exceeded; review capacity before writing');
  return { files, usedBytes, sourceBytes, transferUpperBound, addedUpperBound, existingPaths: new Set(existing.map(x => x.path)) };
}

async function verifiedBytes(port, bucket, path, limit, expectedHash) {
  const bytes = await port.download(bucket, path, limit);
  if (!bytes.length || bytes.length > limit || (expectedHash && digest(bytes) !== expectedHash)) throw new Error(`Integrity check failed: ${path}`);
  return bytes;
}

export async function archive(port, config) {
  const plan = await planArchive(port, config);
  const entries = [];
  for (const f of plan.files) {
    const bytes = await verifiedBytes(port, f.source.bucket, f.path, config.maxObjectBytes);
    if (bytes.length !== f.size) throw new Error('Source changed during archive; rerun after production finishes');
    const hash = digest(bytes);
    const objectPath = `${config.owner}/objects/${hash}.${f.extension}`;
    const id = digest(`${f.source.bucket}\n${f.path}\n${hash}`);
    const entryPath = `${config.owner}/catalog/${id}.json`;
    if (!plan.existingPaths.has(objectPath)) {
      await port.upload(config.bucket, objectPath, bytes, MEDIA.get(f.extension));
      plan.existingPaths.add(objectPath);
    }
    await verifiedBytes(port, config.bucket, objectPath, config.maxObjectBytes, hash);
    const entry = {
      version: 1, id, owner: config.owner, bucket: config.bucket, objectPath,
      sha256: hash, bytes: bytes.length, mime: MEDIA.get(f.extension),
      source: { bucket: f.source.bucket, path: f.path },
      description: f.source.description, tags: f.source.tags,
      reuseStatus: 'needs_review', // Preservation is NOT license or editorial approval.
      archivedAt: new Date().toISOString(),
    };
    if (!plan.existingPaths.has(entryPath)) {
      const metadata = Buffer.from(JSON.stringify(entry));
      if (metadata.length > 16384) throw new Error('Catalog metadata exceeds reserved bytes');
      await port.upload(config.bucket, entryPath, metadata, 'application/json');
      await verifiedBytes(port, config.bucket, entryPath, 16384, digest(metadata));
      plan.existingPaths.add(entryPath);
    } else {
      const stored = validateEntry(JSON.parse((await verifiedBytes(port, config.bucket, entryPath, 16384)).toString('utf8')), config);
      if (stored.id !== id || stored.sha256 !== hash || stored.bytes !== bytes.length) throw new Error('Existing catalog entry does not match archived content');
    }
    entries.push({ id, objectPath, sha256: hash });
  }
  return { archived: entries.length, entries };
}

export function validateEntry(e, config) {
  if (e?.version !== 1 || e.owner !== config.owner || e.bucket !== config.bucket || !/^[a-f0-9]{64}$/.test(e.id) || !/^[a-f0-9]{64}$/.test(e.sha256)) throw new Error('Invalid catalog entry');
  const extension = e.objectPath?.split('.').at(-1);
  if (!MEDIA.has(extension) || e.objectPath !== `${config.owner}/objects/${e.sha256}.${extension}` || !Number.isSafeInteger(e.bytes) || e.bytes <= 0 || e.bytes > config.maxObjectBytes) throw new Error('Invalid catalog object reference');
  return e;
}

export async function catalog(port, config, query = '') {
  validateConfig(config);
  await privateBucket(port, config);
  const result = [];
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const files = await listFiles(port, config.bucket, `${config.owner}/catalog/`);
  if (files.reduce((n, f) => n + f.size, 0) > config.maxTransferBytes) throw new Error('Catalog transfer budget exceeded');
  for (const f of files) {
    if (!f.path.endsWith('.json')) continue;
    const e = validateEntry(JSON.parse((await verifiedBytes(port, config.bucket, f.path, 16384)).toString('utf8')), config);
    if (f.path !== `${config.owner}/catalog/${e.id}.json`) throw new Error('Catalog identity mismatch');
    const text = JSON.stringify([e.description, e.tags, e.source]).toLowerCase();
    if (terms.every(t => text.includes(t))) result.push(e);
  }
  return result;
}

export async function retrieve(port, config, id) {
  validateConfig(config);
  await privateBucket(port, config);
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid catalog id');
  const raw = await verifiedBytes(port, config.bucket, `${config.owner}/catalog/${id}.json`, 16384);
  const entry = validateEntry(JSON.parse(raw.toString('utf8')), config);
  if (entry.id !== id) throw new Error('Catalog identity mismatch');
  if (entry.bytes > config.maxTransferBytes) throw new Error('Transfer budget exceeded');
  const bytes = await verifiedBytes(port, config.bucket, entry.objectPath, config.maxObjectBytes, entry.sha256);
  if (bytes.length !== entry.bytes) throw new Error('Catalog byte count mismatch');
  return { entry, bytes };
}

/** No DELETE, no upsert, no public URLs, no access-policy or subscription changes. */
export function supabasePort(client) {
  const check = (r) => { if (r.error) throw new Error(`Storage operation failed (${r.error.statusCode ?? 'unknown'})`); return r.data; };
  return {
    async bucket(name) {
      const r = await client.storage.getBucket(name);
      if (r.error && String(r.error.statusCode) === '404') return null;
      return check(r);
    },
    async createBucket(name, fileSizeLimit) { check(await client.storage.createBucket(name, { public: false, fileSizeLimit })); },
    async list(bucket, prefix, offset, limit) { return check(await client.storage.from(bucket).list(prefix, { offset, limit, sortBy: { column: 'name', order: 'asc' } })); },
    async download(bucket, path, limit) {
      const blob = check(await client.storage.from(bucket).download(path));
      if (blob.size > limit) throw new Error('Download exceeds object limit');
      return Buffer.from(await blob.arrayBuffer());
    },
    async upload(bucket, path, bytes, contentType) { check(await client.storage.from(bucket).upload(path, bytes, { contentType, upsert: false })); },
  };
}
