// Synthetic-DOM checks of ReelVoicePicker (Level A: simulation, not a real browser; audio decoding not verified).
// HAPPY_DOM_MODULE=/tmp/voice-qa/node_modules/happy-dom/lib/index.js node scripts/verify-reel-voice-picker.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
const { Window } = await import(process.env.HAPPY_DOM_MODULE ?? 'happy-dom');
const window = new Window({ url: 'http://localhost:3000/dashboard/new' });
for (const name of ['window','document','navigator','HTMLElement','HTMLSelectElement','HTMLMediaElement','Event','FormData','localStorage']) {
  Object.defineProperty(globalThis, name, { value: name === 'window' ? window : window[name], configurable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const React = await import('react');
const { createRoot } = await import('react-dom/client');
const { act } = React;
const dir = await mkdtemp(path.resolve('node_modules/.reel-voice-picker-'));
const file = path.join(dir, 'picker.cjs');
await build({ entryPoints: ['src/app/dashboard/new/ReelVoicePicker.tsx'], outfile: file, bundle: true, format: 'cjs', platform: 'node', packages: 'external' });
const { ReelVoicePicker, REEL_VOICE_STORAGE } = createRequire(import.meta.url)(file);

const mine = { voiceId: 'PrivClone001', name: 'duro fixture', accent: null, nativeLanguage: 'es', previewUrl: null, kind: 'private', category: 'professional' };
const stock = { voiceId: 'StockEs0001', name: 'Estándar', accent: 'latino', nativeLanguage: 'es', previewUrl: 'https://example.test/s.mp3', kind: 'stock', category: 'premade' };
let catalogue = { enabled: true, voices: [mine, stock], defaultPreviewUrl: 'https://example.test/d.mp3', defaultName: 'Default' };
let fail = false, fetches = 0, plays = 0, resolvePlay;
globalThis.fetch = async () => { fetches++; return fail ? new Response('', { status: 503 }) : Response.json(catalogue); };
window.HTMLMediaElement.prototype.play = function () { plays++; return new Promise(r => { resolvePlay = r; }); };
window.HTMLMediaElement.prototype.pause = function () { this.dispatchEvent(new window.Event('pause')); };

const box = document.createElement('div'); document.body.append(box);
let root;
const mount = async (language = 'es') => { root = createRoot(box); await act(async () => { root.render(React.createElement(ReelVoicePicker, { language })); }); };
const unmount = async () => { await act(async () => root.unmount()); };
const choose = async value => act(async () => { const s = box.querySelector('#reel_voice_picker'); s.value = value; s.dispatchEvent(new window.Event('change', { bubbles: true })); });
const hidden = () => box.querySelector('[name=reel_voice_id]')?.value ?? null;
const button = () => box.querySelector('button');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
try {
  await mount();
  ok(box.textContent.includes('Seleccionada: Voz predeterminada (Default)'), 'default shown as selected');
  ok(hidden() === null, 'default sends nothing');
  ok(box.querySelector('optgroup[label="Tus voces clonadas (privadas)"]'), 'private group');
  await choose('PrivClone001');
  ok(hidden() === 'PrivClone001', 'selected clone submitted');
  ok(box.textContent.includes('Clon profesional · privada'), 'kind label');
  ok(box.textContent.includes('Sin muestra gratuita'), 'no preview → no generation, explicit note');
  ok(!box.querySelector('audio'), 'no audio for clone without preview');
  ok(JSON.parse(localStorage.getItem(REEL_VOICE_STORAGE('es'))).voiceId === 'PrivClone001', 'persisted');
  await unmount(); await mount();                                   // reload / back-forward
  ok(hidden() === 'PrivClone001', 'restored after reload');
  await choose('StockEs0001');
  ok(box.querySelector('audio').getAttribute('preload') === 'none', 'no preload');
  await act(async () => { button().dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  ok(button().textContent.includes('Cargando'), 'loading state');
  await act(async () => { button().dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  ok(plays === 1, 'double click while loading does not start a second request');
  await act(async () => { resolvePlay(); });
  ok(button().textContent.includes('Pausar'), 'playing state');
  await act(async () => { button().dispatchEvent(new window.MouseEvent('click', { bubbles: true })); });
  ok(button().textContent.includes('Escuchar'), 'paused');
  await act(async () => { box.querySelector('audio').dispatchEvent(new window.Event('error')); });
  ok(box.textContent.includes('La voz seleccionada se conserva') && hidden() === 'StockEs0001', 'preview error keeps choice');
  await choose('PrivClone001'); await unmount();
  catalogue = { ...catalogue, voices: [stock] };                    // clone revoked / deleted
  await mount();
  ok(box.querySelector('[role=alert]')?.textContent.includes('(«duro fixture») ya no está disponible'), 'unavailable message');
  ok(hidden() === null && localStorage.getItem(REEL_VOICE_STORAGE('es')) === null, 'stale id not submitted');
  await unmount();
  localStorage.setItem(REEL_VOICE_STORAGE('es'), JSON.stringify({ voiceId: 'StockEs0001', name: 'Estándar' }));
  fail = true; await mount();
  ok(box.textContent.includes('No pudimos confirmar tu voz guardada («Estándar»)'), 'catalogue failure is explicit about the saved voice');
  ok(hidden() === null, 'unconfirmed voice never submitted');
  await unmount(); fail = false;
  catalogue = { enabled: true, voices: [], defaultPreviewUrl: null, defaultName: null };
  await mount('en');
  ok(box.textContent.includes('Sin muestra gratuita') && box.querySelectorAll('option').length === 1, 'empty catalogue: only default');
  await unmount();
  catalogue = { enabled: false, voices: [], defaultPreviewUrl: null };
  await mount(); ok(box.innerHTML === '', 'flag off renders nothing'); await unmount();
  console.log(`PASS: ${n} picker assertions (Level A, synthetic DOM). fetches=${fetches}, play() calls=${plays}.`);
} finally { await rm(dir, { recursive: true, force: true }); await window.happyDOM.close(); }
