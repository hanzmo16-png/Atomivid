import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soundCueVolume, validateDirection, transitionFrames, cameraTransform, lookStyle, type SoundCue } from './long-form-direction';
const cue: SoundCue = {id:'bed',src:'local.wav',role:'music',startSeconds:5,endSeconds:15,fadeInSeconds:1,fadeOutSeconds:1};
test('cue respects its absolute start/end and ramps smoothly', () => {
  assert.equal(soundCueVolume(cue,4,[cue],[]),0);
  assert.equal(soundCueVolume(cue,5,[cue],[]),0);
  assert.equal(soundCueVolume(cue,15,[cue],[]),0);
  assert.ok(soundCueVolume(cue,5.5,[cue],[]) < soundCueVolume(cue,7,[cue],[]));
});
test('ducking rises inside a real gap and returns before speech resumes', () => {
  const gaps=[{startSeconds:8,endSeconds:10}];
  assert.equal(soundCueVolume(cue,7.9,[cue],gaps),0.1);
  assert.equal(soundCueVolume(cue,9,[cue],gaps),0.2);
  assert.equal(soundCueVolume(cue,10,[cue],gaps),0.1);
});
test('overlapping music/ambience/effects have a capped combined bus', () => {
  const cues: SoundCue[]=Array.from({length:8},(_,i)=>({...cue,id:String(i),role:'effect',gain:2}));
  const total=cues.reduce((v,c)=>v+soundCueVolume(c,9,cues,[{startSeconds:8,endSeconds:10}]),0);
  assert.ok(total<=0.28000001);
});
test('silence and absent cues both validate; duplicate ids, NaN and bad timing fail',()=>{
  validateDirection([],undefined,20); validateDirection([],[],20);
  for(const cues of [[cue,cue],[{...cue,startSeconds:NaN}],[{...cue,endSeconds:21}],[{...cue,gain:Infinity}],[{...cue,sourceStartSeconds:-1}]]) assert.throws(()=>validateDirection([],cues,20));
});
test('cuts do not overlap and dissolves cannot exceed half a scene',()=>{
  assert.equal(transitionFrames({transition:{type:'cut'}},30,4),0);
  assert.equal(transitionFrames({transition:{type:'dissolve',seconds:1}},30,0.4),6);
  assert.equal(transitionFrames(undefined,30,4),15);
});
test('bad scene offsets and motion values reject before render',()=>{
  assert.throws(()=>validateDirection([{id:'x',startSeconds:0,endSeconds:4,direction:{mediaStartSeconds:-1}}],[],4));
  assert.throws(()=>validateDirection([{id:'x',startSeconds:0,endSeconds:4,direction:{transition:{type:'dissolve',seconds:NaN}}}],[],4));
});
test('push/pull use opposite endpoints, pan retains overscan',()=>{
  assert.equal(cameraTransform('push',0),cameraTransform('pull',1));
  assert.equal(cameraTransform('push',1),cameraTransform('pull',0));
  assert.match(cameraTransform('left',1),/scale\(1.08\)/);
  assert.equal(cameraTransform('still',0.5),'none');
});

test('look: absent changes nothing; reframe composes with the camera move; grade and vignette are bounded', () => {
  assert.deepEqual(lookStyle(undefined, 'scale(1.04)'), { transform: 'scale(1.04)', vignette: 0 });
  const l = lookStyle({ scale: 1.2, originX: 0.3, originY: 0.4, contrast: 1.15, saturation: 1.1, vignette: 0.4 }, 'none');
  assert.equal(l.transform, 'scale(1.2)');
  assert.equal(l.transformOrigin, '30% 40%');
  assert.equal(l.filter, 'contrast(1.15) saturate(1.1)');
  assert.equal(l.vignette, 0.4);
  assert.equal(lookStyle({ scale: 1.1 }, 'scale(1.02)').transform, 'scale(1.02) scale(1.1)');
  const scene = (look: object) => [{ id: 's', startSeconds: 0, endSeconds: 2, direction: { look } }];
  assert.doesNotThrow(() => validateDirection(scene({ scale: 1.2, contrast: 1.15, vignette: 0.4 }), [], 2));
  for (const bad of [{ scale: 2 }, { scale: 0.9 }, { contrast: 3 }, { saturation: 0 }, { vignette: 1 }, { originX: -0.1 }, { scale: Number.NaN }]) {
    assert.throws(() => validateDirection(scene(bad), [], 2), /Invalid look/, JSON.stringify(bad));
  }
});
