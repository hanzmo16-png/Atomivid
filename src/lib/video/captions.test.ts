import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCaptions} from './captions';
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
