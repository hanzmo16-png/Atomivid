/** Local, zero-spend check of the V3 fit/splice against the V2 stems and the approved gate audio. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {applyPatch, findSpan, gateWords} from '../v3';
import {probeDuration} from '../../lib/contact-sheet';

async function main() {
  const S = process.env.S!; const work = path.join(S, 'v3local', 'work'); await fs.mkdir(work, {recursive: true});
  const gate = JSON.parse(await fs.readFile(path.join(S, 'run-gate/video-004-pron-gate/pron-gate-report.json'), 'utf8'));
  const cases: [string, string, string][] = [['S1', 'G1', 'It is a harder story than the legend. And a better one. This is Thermopylae.'], ['S3', 'G3', 'On the road north, the allies joined: men from Tegea and Mantinea, Corinth, Phlius, Mycenae, seven hundred from Thespiae, four hundred from Thebes, and the Phocians and Locrians, whose land lay just beyond the pass.'], ['S6', 'G2', "And then, that evening, a local man came to the king's tent. His name was Ephialtes, from Trachis."]];
  for (const [sc, g, display] of cases) {
    const rec = JSON.parse(await fs.readFile(path.join(S, `run-02/v4/narration-${sc}.json`), 'utf8'));
    const wav = path.join(work, `${sc}.wav`);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(S, `run-02/v4/narration-${sc}.mp3`), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', wav]);
    const sceneSeconds = await probeDuration(wav);
    const sample = gate.samples.find((x: {sampleId: string}) => x.sampleId === g);
    const span = findSpan(rec.words, display); if (!span) { console.log(sc, g, 'SPAN NOT FOUND'); continue; }
    const r = await applyPatch({sceneWav: wav, sceneWords: rec.words, sceneSeconds, patchAudio: path.join(S, `run-gate/video-004-pron-gate/${g}.mp3`), patchWords: gateWords(sample.words), span, work, tag: `${sc}-${g}`});
    if ('blocker' in r) { console.log(sc, g, r.blocker); continue; }
    const outDur = await probeDuration(r.wav);
    const changed = r.words.filter((w: {startSeconds: number; endSeconds: number}, i: number) => w.startSeconds !== rec.words[i].startSeconds || w.endSeconds !== rec.words[i].endSeconds).length;
    const later = r.words.slice(span[1] + 1).every((w: {startSeconds: number}, i: number) => w.startSeconds === rec.words[span[1] + 1 + i].startSeconds);
    console.log(JSON.stringify({sc, g, span, sceneSeconds: +sceneSeconds.toFixed(3), outSeconds: +outDur.toFixed(3), fit: r.fit, gainDb: +r.gainDb.toFixed(2), lufsOriginal: +r.lufsOriginal.toFixed(2), lufsPatch: +r.lufsPatch.toFixed(2), wordsChanged: changed, laterWordsIntact: later, firstNew: r.words[span[0]], lastNew: r.words[span[1]], origFirst: rec.words[span[0]], origLast: rec.words[span[1]]}));
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
