import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCaptions, buildSceneCaptions} from './captions';
const words=(text:string)=>text.split(' ').map((text,i)=>({text,startSeconds:i/3,endSeconds:(i+1)/3}));
test('sentence ending never joins the next sentence after a size boundary',()=>{
 const input=words('Uno dos tres cuatro cinco seis siete hace. El problema es esperar.');
 const captions=buildCaptions(input,new Set());
 assert.ok(!captions.some(c=>c.text.includes('hace. El')));
 assert.equal(captions.map(c=>c.text).join(' '),input.map(w=>w.text).join(' '));
 assert.equal(captions.at(-1)!.endSeconds,input.at(-1)!.endSeconds);
});
test('final short sentence does not merge across punctuation',()=>{
 const c=buildCaptions(words('Todo cambia. Actúa.'),new Set());
 assert.deepEqual(c.map(x=>x.text),['Todo cambia.','Actúa.']);
});
test('quoted sentence endings break and emphasis survives',()=>{
 const c=buildCaptions(words('Hazlo ahora.” El problema desaparece.'),new Set(['ahora']));
 assert.equal(c[0].text,'Hazlo ahora.”');assert.equal(c.length,2);
});
test('Reel: a caption never straddles a scene cut, even without punctuation at the scene end',()=>{
 const scenes=['Esto cambia todo cuando','La mayoría se rinde antes de ver resultados.'];
 const input=words(scenes.join(' '));
 const flat=buildCaptions(input,new Set()).map(c=>c.text);
 assert.ok(flat.some(t=>t.includes('cuando La')),'precondition: the flat grouping crosses the cut');
 const c=buildSceneCaptions(input,scenes,new Set());
 assert.ok(!c.some(x=>x.text.includes('cuando La')));
 assert.equal(c.map(x=>x.text).join(' '),input.map(w=>w.text).join(' '));
 const cut=input[4].startSeconds;
 assert.ok(c.every(x=>x.endSeconds<=cut||x.startSeconds>=cut));
});
test('Reel scene captions keep extra words with the last scene',()=>{
 const input=words('Uno dos. Tres cuatro cinco.');
 const c=buildSceneCaptions(input,['Uno dos.','Tres'],new Set());
 assert.equal(c.map(x=>x.text).join(' '),'Uno dos. Tres cuatro cinco.');
});
