import { VOICE_PRESETS } from "../../src/lib/audio-studio/model.ts";
import { parseVoiceMap } from "../../src/lib/audio-studio/voice.ts";
import { catalogFrom } from "../../src/lib/audio-studio/catalog.ts";
// Read-only catalog check. Never prints credentials, private clones or account information.
const key = process.env.ELEVENLABS_API_KEY;
if (!key) throw new Error('Missing ElevenLabs credential');
const response = await fetch('https://api.elevenlabs.io/v1/voices', {
  headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(20000),
});
if (!response.ok) throw new Error(`Voice catalog HTTP ${response.status}`);
const { voices = [] } = await response.json();
const map = parseVoiceMap(process.env.AUDIO_STUDIO_ELEVENLABS_VOICES);
if (!map) throw new Error('Worker voice configuration incomplete');
const catalog = catalogFrom(voices, map);
let incomplete = false;
for (const language of ['es', 'en']) {
  for (const gender of ['masculina', 'femenina']) {
    const selected = VOICE_PRESETS.filter(p => p.language === language && p.gender === gender);
    const ready = selected.filter(p => catalog.some(v => v.id === p.id && v.previewUrl && v.models.includes('eleven_multilingual_v2')));
    console.log('VERIFIED', language, gender, ready.length, ready.map(p => p.label).join(', '));
    if (ready.length < 6) incomplete = true;
    console.log('UNAVAILABLE', selected.filter(p => !ready.includes(p)).map(p => p.id).join(', '));
  }
}
console.log('PUBLIC_CATALOG_READ_OK');
const modelsResponse = await fetch('https://api.elevenlabs.io/v1/models', {
  headers: { 'xi-api-key': key }, signal: AbortSignal.timeout(20000),
});
if (!modelsResponse.ok) throw new Error(`Models HTTP ${modelsResponse.status}`);
const models = await modelsResponse.json();
for (const model of ['eleven_multilingual_v2', 'eleven_v4_turbo']) {
  const liveModel = models.find(m => m.model_id === model && m.can_do_text_to_speech);
  if (!liveModel || !['es', 'en'].every(l => liveModel.languages?.some(v => v.language_id === l))) throw new Error(`Model unavailable: ${model}`);
  for (const language of ['es', 'en']) for (const gender of ['masculina', 'femenina']) {
    const ready = VOICE_PRESETS.filter(p => p.language === language && p.gender === gender && catalog.some(v => v.id === p.id && v.models.includes(model)));
    console.log('MODEL_READY', model, language, gender, ready.length);
    if (ready.length < 6) incomplete = true;
  }
}
for (const id of ['es-public-m-brian', 'es-public-f-alice']) {
  const preview = catalog.find(v => v.id === id)?.previewUrl;
  if (!preview) throw new Error(`No preview for ${id}`);
  const r = await fetch(preview, { headers: { Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(20000) });
  const first = await r.body?.getReader().read();
  if (!r.ok || !first?.value?.length) throw new Error(`Preview unavailable: ${id}`);
  console.log('PREVIEW_OK', id, r.status, r.headers.get('content-type'));
}


if (incomplete) throw new Error('Incomplete real voice catalog');
