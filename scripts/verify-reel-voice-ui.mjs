// React DOM interaction checks in a synthetic DOM, not a real browser or a production acceptance test.
// HAPPY_DOM_MODULE=/tmp/voice-qa/node_modules/happy-dom/lib/index.js node scripts/verify-reel-voice-ui.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const { Window } = await import(process.env.HAPPY_DOM_MODULE ?? 'happy-dom');
const window = new Window({ url: 'http://localhost:3000/dashboard/new' });
for (const name of ['window','document','navigator','HTMLElement','HTMLSelectElement','Event','MouseEvent','StorageEvent','FormData']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? window : window[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;
const directory = await mkdtemp(path.resolve('node_modules/.reel-voice-ui-'));
const file = path.join(directory, 'form.cjs');
await build({ entryPoints: ['src/app/dashboard/new/NewVideoForm.tsx'], outfile: file, bundle: true, format: 'cjs', platform: 'node', packages: 'external' });
const { NewVideoForm } = createRequire(import.meta.url)(file);
const container = document.createElement('div'); document.body.append(container);
const root = createRoot(container);
let failCatalogue = false, calls = 0;
const originalFetch = globalThis.fetch;
const voice = { voiceId: 'voiceEsp01', name: 'Voz de prueba', accent: null, nativeLanguage: 'es', previewUrl: 'https://example.test/voice.mp3' };
globalThis.fetch = async url => {
  assert.match(String(url), /^\/api\/reel\/voices\?language=(es|en)$/);
  calls++;
  if (failCatalogue) return new Response('', { status: 503 });
  return Response.json({ enabled: true, voices: [voice], defaultPreviewUrl: null });
};
const props = { action: () => {}, avatarModeEnabled: true, existingAvatars: [], reelVoiceSelectionEnabled: true };
const render = async extra => { await act(async () => { root.render(React.createElement(NewVideoForm, { ...props, ...extra })); }); };
const select = async (id, value) => { await act(async () => {
  const element = container.querySelector(id); assert.ok(element); element.value = value; element.dispatchEvent(new window.Event('change', { bubbles: true }));
}); };
try {
  await render({ reelVoiceSelectionEnabled: false });
  assert.equal(container.querySelector('#reel_voice_picker'), null); assert.equal(calls, 0);
  await render({});
  assert.ok(container.querySelector('#reel_voice_picker')); assert.equal(calls, 1);
  assert.equal(new window.FormData(container.querySelector('form')).get('reel_voice_id'), null);
  await select('#reel_voice_picker', voice.voiceId);
  assert.equal(new window.FormData(container.querySelector('form')).get('reel_voice_id'), voice.voiceId);
  const audio = container.querySelector('audio'); assert.equal(audio.getAttribute('preload'), 'none');
  await act(async () => { audio.dispatchEvent(new window.Event('error')); });
  assert.match(container.textContent, /La voz seleccionada se conserva/);
  assert.equal(container.querySelector('[name=reel_voice_id]').value, voice.voiceId);
  await select('#language', 'en');
  assert.equal(container.querySelector('[name=reel_voice_id]'), null, 'language switch clears the old choice');
  assert.equal(container.querySelector('audio'), null, 'language switch removes old audio');
  await select('#reel_voice_picker', voice.voiceId);
  await select('#reel_voice_picker', '');
  assert.equal(container.querySelector('[name=reel_voice_id]'), null);
  failCatalogue = true;
  await select('#language', 'es');
  assert.match(container.textContent, /Puedes continuar con la voz predeterminada/);
  assert.equal(container.querySelector('[name=reel_voice_id]'), null);
  await act(async () => { root.unmount(); });
  const root2 = createRoot(container);
  await act(async () => { root2.render(React.createElement(NewVideoForm, { ...props, initialMode: 'avatar' })); });
  assert.equal(container.querySelector('#reel_voice_picker'), null);
  await act(async () => { root2.unmount(); });
  console.log('PASS: 12 UI assertions — actual NewVideoForm, flag off, default omission, selected voice submission, preview error, language reset, default reset, catalogue failure and Avatar isolation. Synthetic DOM; audio playback not verified.');
} finally {
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
  await window.happyDOM.close();
}
