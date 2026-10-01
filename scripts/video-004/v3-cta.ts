/** V3 plan overlay and CTA definitions (type-only dependency on shared, so loadPlan can import it). */
import type {Shot} from './shared';

export const V3 = process.env.V4_V3 === 'true';
export const V2_MASTER_SHA = 'eca494aa3881204724c7a9211f7eebc08893ffb3caa3ed587fe626ba4e236b10';

export type CtaDef = {scene: string; id: string; afterScene: string; candidates: string[]; purpose: string; line: string; mark: [string, string]; pause: number; bell: boolean};
/** Post-hook CTA after the title beat (S1) and final CTA after the last sentence (S9), before the end card. English, same voice, no black. */
export const CTA: CtaDef[] = [
  {scene: 'CTA1', id: 'V4-CTA1', afterScene: 'S1', candidates: ['V4-092', 'V4-035', 'V4-013', 'V4-012'], purpose: 'cta: post-hook', line: 'If you want more history told this carefully, subscribe. Now, back to the pass.', mark: ['SUBSCRIBE', 'Earthward Chronicles'], pause: 0.6, bell: false},
  {scene: 'CTA2', id: 'V4-CTA2', afterScene: 'S9', candidates: ['V4-093', 'V4-092', 'V4-096', 'V4-097'], purpose: 'cta: final', line: 'If this stayed with you, subscribe and turn on notifications: the next documentary is already on its way.', mark: ['SUBSCRIBE', 'Turn on notifications'], pause: 1.2, bell: true},
];
export const ctaShot = (c: CtaDef): Shot => ({id: c.id, planShotId: null, scene: c.scene, kind: 'stock', seconds: 7, purpose: c.purpose, visual: `CTA over approved picture (${c.candidates.join(' | ')})`, narration: c.line, pause: c.pause, method: 'CTA_REUSE', provider: 'internal', cls: 'landscape', continuity: null, generative: false});
/** Inserts the CTA shots: after the last S1 shot, and before the end card. Nothing else moves in the list. */
export function withCtaShots(shots: Shot[]): Shot[] {
  const result: Shot[] = [];
  shots.forEach((s, i) => {
    if (s.purpose === 'end card') for (const c of CTA.filter((c) => c.afterScene === 'S9')) result.push(ctaShot(c));
    result.push(s);
    if (s.scene === 'S1' && shots[i + 1]?.scene !== 'S1') for (const c of CTA.filter((c) => c.afterScene === 'S1')) result.push(ctaShot(c));
  });
  return result;
}
/** Lower-right subscribe mark inside the 96/54 safe area (1920x1080, transparent). The episode's ink/accent palette. */
export function ctaMarkSvg(c: CtaDef): string {
  const w = c.bell ? 600 : 560, h = 84, x = 1920 - 96 - w, y = 54 + 20;
  const bell = c.bell ? `<path transform="translate(${x + 24} ${y + 20})" d="M22 4c-6 0-11 5-11 11v9l-5 7v3h32v-3l-5-7v-9c0-6-5-11-11-11zm-5 33a5 5 0 0 0 10 0z" fill="#e6ddd0"/>` : `<polygon points="${x + 26},${y + 24} ${x + 26},${y + 60} ${x + 58},${y + 42}" fill="#c9a24a"/>`;
  return `<svg width="1920" height="1080" viewBox="0 0 1920 1080" xmlns="http://www.w3.org/2000/svg"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#121212" fill-opacity="0.72" stroke="#7a6a58" stroke-width="2"/>${bell}<text x="${x + 78}" y="${y + 52}" font-family="DejaVu Sans" font-weight="bold" font-size="34" fill="#e6ddd0">${c.mark[0]}</text><text x="${x + 78 + (c.mark[0].length * 23) + 14}" y="${y + 52}" font-family="DejaVu Sans" font-size="26" fill="#c9bfae">· ${c.mark[1]}</text></svg>`;
}
