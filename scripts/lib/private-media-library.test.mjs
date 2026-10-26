import test from 'node:test';
import assert from 'node:assert/strict';
import { archive, catalog, digest, listFiles, planArchive, privateBucket, retrieve, supabasePort, validateConfig } from './private-media-library.mjs';

const config = () => ({ owner: 'hans-channel', bucket: 'channel-library-private', maxObjectBytes: 1000000, maxTransferBytes: 10000000, maxLibraryBytes: 10000000, sources: [{ bucket: 'videos', prefix: 'long-form/ocean-deep-001/', description: 'Ocean documentary', tags: ['ocean', 'deep sea'] }] });
function memory() {
  const objects = new Map();
  const buckets = new Map([['videos', { public: true }], ['channel-library-private', { public: false }]]);
  const writes = [];
  const p = {
    async bucket(name) { return buckets.get(name) ?? null; },
    async createBucket(name) { buckets.set(name, { public: false }); },
    async list(bucket, prefix, offset, limit) {
      const rows = new Map();
      const start = bucket + '/' + (prefix ? prefix + '/' : '');
      for (const [key, bytes] of objects) {
        if (!key.startsWith(start)) continue;
        const rel = key.slice(start.length);
        const name = rel.split('/')[0];
        rows.set(name, rel.includes('/') ? { name, id: null, metadata: null } : { name, id: key, metadata: { size: bytes.length } });
      }
      return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(offset, offset + limit);
    },
    async download(bucket, path) { const b = objects.get(bucket + '/' + path); if (!b) throw new Error('missing'); return b; },
    async upload(bucket, path, bytes) {
      const key = bucket + '/' + path;
      if (objects.has(key)) throw new Error('conflict');
      objects.set(key, bytes); writes.push(path);
    },
  };
  const seed = (path, bytes = Buffer.from('clip-content')) => objects.set('videos/' + path, bytes);
  return { p, objects, buckets, writes, seed };
}

test('archives only selected project; verifies copies; search and retrieval require no generation', async () => {
  const m = memory(); const c = config();
  m.seed('long-form/ocean-deep-001/ai-video/rov.mp4');
  m.seed('long-form/other/secret.mp4');
  m.seed('long-form/ocean-deep-001/state/ledger.json');
  const result = await archive(m.p, c);
  assert.equal(result.archived, 1);
  const rows = await catalog(m.p, c, 'ocean sea');
  assert.equal(rows.length, 1); assert.equal(rows[0].reuseStatus, 'needs_review');
  assert.deepEqual((await retrieve(m.p, c, rows[0].id)).bytes, Buffer.from('clip-content'));
  assert.equal(m.objects.has('videos/long-form/ocean-deep-001/ai-video/rov.mp4'), true);
  m.objects.delete('videos/long-form/ocean-deep-001/ai-video/rov.mp4');
  assert.deepEqual((await retrieve(m.p, c, rows[0].id)).bytes, Buffer.from('clip-content'));
});
test('same bytes share a blob; reruns do not overwrite; changed sources retain old versions', async () => {
  const m = memory(); const c = config();
  m.seed('long-form/ocean-deep-001/a.mp4'); m.seed('long-form/ocean-deep-001/b.mp4');
  await archive(m.p, c); assert.equal(m.writes.length, 3);
  await archive(m.p, c); assert.equal(m.writes.length, 3);
  m.seed('long-form/ocean-deep-001/a.mp4', Buffer.from('new-clip'));
  await archive(m.p, c); assert.equal((await catalog(m.p, c)).length, 3);
});
test('failed upload leaves source intact; retry completes without overwriting the blob', async () => {
  const m = memory(); const c = config(); m.seed('long-form/ocean-deep-001/a.mp4');
  const upload = m.p.upload;
  m.p.upload = async (...args) => { if (args[1].includes('/catalog/')) throw new Error('outage'); return upload(...args); };
  await assert.rejects(archive(m.p, c), /outage/);
  assert.equal(m.writes.length, 1); assert.equal(m.objects.size, 2);
  m.p.upload = upload; await archive(m.p, c); assert.equal(m.writes.length, 2);
});
test('corrupt destination is detected before a catalog entry is created', async () => {
  const m = memory(); const c = config(); m.seed('long-form/ocean-deep-001/a.mp4');
  const upload = m.p.upload;
  m.p.upload = (b, p, bytes) => upload(b, p, Buffer.concat([bytes, Buffer.from('corruption')]));
  await assert.rejects(archive(m.p, c), /Integrity/); assert.equal(m.writes.length, 1);
});
test('private bucket enforced, no client policy or public-bucket conversion', async () => {
  const m = memory(); const c = config(); m.buckets.set(c.bucket, { public: true });
  await assert.rejects(archive(m.p, c), /private/); assert.equal(m.writes.length, 0);
  m.buckets.delete(c.bucket); await privateBucket(m.p, c, true); assert.equal(m.buckets.get(c.bucket).public, false);
});
test('capacity and transfer ceilings block before downloads and writes', async () => {
  const m = memory(); const c = config(); m.seed('long-form/ocean-deep-001/a.mp4');
  m.p.download = () => { throw new Error('must not download'); };
  c.maxLibraryBytes = 10; await assert.rejects(archive(m.p, c), /byte budget/);
  c.maxLibraryBytes = 1000000; c.maxTransferBytes = 1; await assert.rejects(archive(m.p, c), /Transfer budget/);
  assert.equal(m.writes.length, 0);
});
test('pagination traverses more than 100 objects and excludes sibling prefixes', async () => {
  const m = memory();
  for (let i = 0; i < 205; i++) m.seed(`long-form/ocean-deep-001/clips/${String(i).padStart(4, '0')}.mp4`);
  m.seed('long-form/ocean-deep-001-other/a.mp4');
  assert.equal((await listFiles(m.p, 'videos', 'long-form/ocean-deep-001/')).length, 205);
});
test('unknown sizes and listing failures are not interpreted as empty capacity', async () => {
  const m = memory();
  m.p.list = async () => [{ name: 'x.mp4', id: 'x', metadata: {} }];
  await assert.rejects(planArchive(m.p, config()), /Unknown object size/);
  m.p.list = async () => { throw new Error('forbidden'); };
  await assert.rejects(planArchive(m.p, config()), /forbidden/);
});
test('root scans, traversal, overlapping scopes and missing budgets rejected', () => {
  for (const prefix of ['', 'long-form/', '../ocean/', 'long-form/../ocean/', '/long-form/ocean/']) {
    const c = config(); c.sources[0].prefix = prefix; assert.throws(() => validateConfig(c));
  }
  const c = config(); c.sources.push({ ...c.sources[0] }); assert.throws(() => validateConfig(c));
  assert.throws(() => validateConfig({ ...config(), maxLibraryBytes: undefined }));
});
test('catalog cannot redirect downloads into another owner or source bucket', async () => {
  const m = memory(); const c = config(); m.seed('long-form/ocean-deep-001/a.mp4');
  const { entries } = await archive(m.p, c);
  const key = `${c.bucket}/${c.owner}/catalog/${entries[0].id}.json`;
  const e = JSON.parse(m.objects.get(key)); e.objectPath = `another-owner/objects/${e.sha256}.mp4`;
  m.objects.set(key, Buffer.from(JSON.stringify(e)));
  await assert.rejects(retrieve(m.p, c, e.id), /reference/);
});
test('SDK adapter fails closed on 403 and never overwrites storage', async () => {
  const calls = [];
  const client = { storage: {
    getBucket: async () => ({ error: { statusCode: 403 } }),
    from: () => ({ upload: async (...args) => { calls.push(args); return { data: {} }; } }),
  } };
  const port = supabasePort(client);
  await assert.rejects(port.bucket('test'), /403/);
  await port.upload('test', 'test.mp4', Buffer.from('x'), 'video/mp4');
  assert.equal(calls[0][2].upsert, false);
  assert.equal(digest(Buffer.from('x')).length, 64);
});

test('rerun refuses a corrupted catalog instead of silently reporting success', async () => {
  const m = memory(); const c = config(); m.seed('long-form/ocean-deep-001/a.mp4');
  const r = await archive(m.p, c);
  const path = `${c.bucket}/${c.owner}/catalog/${r.entries[0].id}.json`;
  const e = JSON.parse(m.objects.get(path)); e.bytes += 1;
  m.objects.set(path, Buffer.from(JSON.stringify(e)));
  await assert.rejects(archive(m.p, c), /does not match/);
});
