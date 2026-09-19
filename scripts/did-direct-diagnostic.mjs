import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

async function main() {
  const key = process.env.DID_API_KEY?.trim();
  if (!key) throw new Error('missing_config');
  if (Date.now() > Date.parse('2026-09-19T03:00:00Z')) throw new Error('authorization_expired');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: rows, error } = await db.from('video_requests')
    .select('id,user_id,status,mode,avatar_id,recorded_audio_path,render_attempts,avatar_provider_video_job_id')
    .eq('mode','avatar').eq('status','failed');
  if (error) throw new Error('request_read_failed');
  const row = rows?.find(r => createHash('sha256').update(r.id).digest('hex') === '24ad45b839f41c3c20e23d3a1b85e5d4e946fd66d1bead27865e4dbd506239b5');
  if (!row || row.render_attempts !== 2 || row.avatar_provider_video_job_id) throw new Error('request_not_eligible');
  const { data: avatar, error: ae } = await db.from('avatars').select('user_id,source_photo_path').eq('id',row.avatar_id).single();
  const prefix = row.user_id + '/' + row.id + '/';
  if (ae || avatar.user_id !== row.user_id || !['photo.jpeg','photo.png'].some(n => avatar.source_photo_path === prefix+n)
    || !['recording.m4a','recording.wav','recording.mp3'].some(n => row.recorded_audio_path === prefix+n)) throw new Error('asset_ownership_failed');
  const { data: bi, error: be } = await db.storage.getBucket('avatar-uploads');
  if (be || !bi || bi.public) throw new Error('private_bucket_required');
  const bucket = db.storage.from('avatar-uploads');
  const { data: audio, error: de } = await bucket.download(row.recorded_audio_path);
  if (de || !audio || audio.size !== 699576) throw new Error('audio_integrity_failed');
  const dir = await mkdtemp(join(tmpdir(),'did-direct-'));
  let seconds;
  try {
    const file = join(dir,'recording');
    await writeFile(file,Buffer.from(await audio.arrayBuffer()));
    seconds = Number(execFileSync('ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',file],{encoding:'utf8'}).trim());
  } finally { await rm(dir,{recursive:true,force:true}); }
  if (!Number.isFinite(seconds) || Math.abs(seconds-42.794) > 0.02 || Math.ceil(seconds/15)>3) throw new Error('duration_budget_failed');
  const { data: photoUrl, error: pe } = await bucket.createSignedUrl(avatar.source_photo_path,3600);
  const { data: audioUrl, error: ue } = await bucket.createSignedUrl(row.recorded_audio_path,3600);
  if (pe || ue || !photoUrl || !audioUrl) throw new Error('asset_signing_failed');
  const reportPath = prefix+'direct-diagnostic-20260919.json';
  const lock = await bucket.upload(prefix+'direct-diagnostic-20260919.lock',Buffer.from(new Date().toISOString()),{upsert:false,contentType:'text/plain'});
  if (lock.error) throw new Error('attempt_already_reserved');
  const report = { started_at: new Date().toISOString(), response: null, transport_error: null };
  const save = async () => {
    const result = await bucket.upload(reportPath,Buffer.from(JSON.stringify(report,null,2)),{upsert:true,contentType:'application/json'});
    if (result.error) throw new Error('private_report_save_failed');
  };
  await save();
  try {
    // Exactly ONE POST, no retry and no redirects. No app provider or classifier.
    const response = await fetch('https://api.d-id.com/talks',{
      method:'POST', redirect:'error', signal:AbortSignal.timeout(60000),
      headers:{ Authorization:'Basic '+Buffer.from(key,'utf8').toString('base64'), 'Content-Type':'application/json' },
      body:JSON.stringify({source_url:photoUrl.signedUrl,script:{type:'audio',audio_url:audioUrl.signedUrl},config:{result_format:'mp4'}})
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    report.response = { http_status:response.status, status_text:response.statusText, headers:Array.from(response.headers.entries()), body_text:bytes.toString('utf8'), body_base64:bytes.toString('base64') };
  } catch (e) {
    report.transport_error = {name:e instanceof Error ? e.name : 'UnknownError'};
  }
  await save();
  console.log('PRIVATE_RAW_RESPONSE_SAVED');
}
main().catch(()=>{console.error('DIRECT_DIAGNOSTIC_STOPPED_NO_RETRY');process.exitCode=1;});
