#!/usr/bin/env node
/** Operator-only CLI. Node 20+, existing @supabase/supabase-js dependency. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { archive, catalog, digest, listFiles, planArchive, privateBucket, retrieve, supabasePort, validateConfig } from './lib/private-media-library.mjs';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    config: { type: 'string' }, apply: { type: 'boolean', default: false },
    query: { type: 'string', default: '' }, id: { type: 'string' }, out: { type: 'string' },
    help: { type: 'boolean', default: false },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log('Usage: node scripts/private-media-library.mjs inventory | init | archive | search | get | backup --config /private/config.json [--apply] [--query ocean] [--id SHA256] [--out /private/output]');
    return;
  }
  if (positionals.length !== 1 || !['inventory', 'init', 'archive', 'search', 'get', 'backup'].includes(command)) throw new Error('Unknown command');
  if (!values.config) throw new Error('--config required');
  const config = validateConfig(JSON.parse(await readFile(values.config, 'utf8')));
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase URL and service-role key must be provided through the environment');
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/') throw new Error('Use the canonical HTTPS Supabase project URL');
  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const port = supabasePort(client);
  if (command === 'inventory') {
    const { data, error } = await client.storage.listBuckets();
    if (error) throw new Error('Could not list storage buckets');
    const buckets = [];
    for (const b of data) {
      const files = await listFiles(port, b.id);
      buckets.push({ bucket: b.id, public: b.public, objects: files.length, bytes: files.reduce((n, f) => n + f.size, 0) });
    }
    console.log(JSON.stringify({ buckets, totalBytes: buckets.reduce((n, b) => n + b.bytes, 0), billingPlan: 'not_available_from_storage_api', note: 'Point-in-time object sizes; verify organization quota, billed average, egress and spend cap in dashboard.' }, null, 2));
  } else if (command === 'init') {
    if (!values.apply) { console.log('Dry run: would create/verify a dedicated private bucket; no policies, billing or existing buckets changed.'); return; }
    await privateBucket(port, config, true);
    console.log('Private archive bucket verified. No client access policies added.');
  } else if (command === 'archive') {
    const result = values.apply ? await archive(port, config) : await planArchive(port, config);
    console.log(JSON.stringify(values.apply ? result : { dryRun: true, files: result.files.length, usedBytes: result.usedBytes, sourceBytes: result.sourceBytes, transferUpperBound: result.transferUpperBound, addedUpperBound: result.addedUpperBound }, null, 2));
  } else if (command === 'search') {
    console.log(JSON.stringify(await catalog(port, config, values.query), null, 2));
  } else if (command === 'get') {
    if (!values.id || !values.out) throw new Error('--id and --out required');
    const { entry, bytes } = await retrieve(port, config, values.id);
    await writeFile(resolve(values.out), bytes, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ saved: resolve(values.out), sha256: entry.sha256, reuseStatus: entry.reuseStatus }));
  } else if (command === 'backup') {
    if (!values.out) throw new Error('--out required; use a private location outside ephemeral CI storage');
    const entries = await catalog(port, config);
    const unique = new Map(entries.map(e => [e.objectPath, e]));
    if ([...unique.values()].reduce((n, e) => n + e.bytes, 0) > config.maxTransferBytes) throw new Error('Backup transfer budget exceeded');
    const root = resolve(values.out);
    await mkdir(root, { recursive: true, mode: 0o700 });
    for (const e of unique.values()) {
      const target = join(root, e.objectPath);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      let existing;
      try { existing = await readFile(target); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      if (existing) { if (digest(existing) !== e.sha256) throw new Error('Existing backup object failed verification'); continue; }
      const { bytes } = await retrieve(port, config, e.id);
      await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
    }
    const manifest = Buffer.from(JSON.stringify({ version: 1, owner: config.owner, createdAt: new Date().toISOString(), entries }, null, 2));
    const manifestPath = join(root, `catalog-${digest(manifest)}.json`);
    await writeFile(manifestPath, manifest, { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ exportedObjects: unique.size, manifestPath, note: 'Export complete. This is an independent backup only if the destination is durable and separate from the primary project.' }));
  }
}

main().catch(() => { console.error('Media-library operation failed. No cleanup or paid generation was attempted. Check credentials, limits, config and Storage availability; run tests or inspect the failing operation in a trusted environment.'); process.exitCode = 1; });
