// Read-only catalog check. Never prints credentials, private clones or account information.
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('Missing ElevenLabs credential');
const response = await fetch('https://api.elevenlabs.io/v1/voices', {
  headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(20000),
});
if (!response.ok) throw new Error(`Voice catalog HTTP ${response.status}`);
const { voices = [] } = await response.json();
for (const v of voices.filter(v => v.category === 'premade')) {
  console.log(JSON.stringify({ voice_id: v.voice_id, name: v.name, labels: v.labels,
    preview_url: v.preview_url, category: v.category,
    models: v.high_quality_base_model_ids, fine_tuning: v.fine_tuning?.state }));
}
console.log('PUBLIC_CATALOG_READ_OK');
