// Minimal Supabase Storage REST client for the review-delivery workflow (no SDK, no install).
// Signed URLs are written to files only; the workflow never prints them (Actions masks JWTs anyway).
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';

const URL_ = process.env.SUPABASE_URL?.replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) throw Error('Supabase credentials missing');
const H = {Authorization: `Bearer ${KEY}`, apikey: KEY};
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

export const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export async function list(bucket, prefix) {
  const r = await fetch(`${URL_}/storage/v1/object/list/${bucket}`, {method: 'POST', headers: {...H, 'Content-Type': 'application/json'}, body: JSON.stringify({prefix, limit: 1000, offset: 0, sortBy: {column: 'name', order: 'asc'}})});
  if (!r.ok) throw Error(`list ${bucket}/${prefix} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function download(bucket, path, dest) {
  const r = await fetch(`${URL_}/storage/v1/object/${bucket}/${enc(path)}`, {headers: H});
  if (!r.ok) throw Error(`download ${bucket}/${path} HTTP ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  if (dest) await fs.writeFile(dest, b);
  return b;
}

export async function upload(bucket, path, file, contentType) {
  const b = await fs.readFile(file);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = await fetch(`${URL_}/storage/v1/object/${bucket}/${enc(path)}`, {method: 'POST', headers: {...H, 'Content-Type': contentType, 'x-upsert': 'true', 'cache-control': 'max-age=0'}, body: b});
    if (r.ok) return {path, bytes: b.length, sha256: sha256(b)};
    const t = (await r.text()).slice(0, 200);
    if (attempt === 3 || r.status < 500) throw Error(`upload ${bucket}/${path} HTTP ${r.status}: ${t}`);
    await new Promise((res) => setTimeout(res, 4000 * attempt));
  }
}

export async function sign(bucket, path, seconds, downloadName) {
  const r = await fetch(`${URL_}/storage/v1/object/sign/${bucket}/${enc(path)}`, {method: 'POST', headers: {...H, 'Content-Type': 'application/json'}, body: JSON.stringify({expiresIn: seconds})});
  if (!r.ok) throw Error(`sign ${bucket}/${path} HTTP ${r.status}`);
  const {signedURL} = await r.json();
  const u = `${URL_}/storage/v1${signedURL}`;
  return downloadName ? `${u}&download=${encodeURIComponent(downloadName)}` : u;
}
