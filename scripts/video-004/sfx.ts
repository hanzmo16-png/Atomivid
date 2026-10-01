/** Video #004 V2 sound design (USD 0, no external assets): procedural cues synthesised by FFmpeg from
 * noise and sine sources, placed on the narration-led timeline and ducked under the voice like the music
 * bed. Dynamics come from the cue table (swells, impacts) and from V2_MUSIC_DROPS (intentional silences).
 * No recording from any library is used, so no attribution is required. */

export type SfxKind = 'wind' | 'sea' | 'march' | 'crowd' | 'arrows' | 'impact' | 'drums' | 'fire' | 'hooves' | 'breath' | 'oars' | 'knock' | 'rumble' | 'leaves' | 'whip' | 'steam';
export type SfxCue = {kind: SfxKind; at: number; dur: number; gain: number};

/** Lavfi source + filters for a cue of `d` seconds (gain applied by the caller). */
export function sfxSource(kind: SfxKind, d: number, seed: number): string {
  const n = (c: string) => `anoisesrc=c=${c}:r=48000:d=${d.toFixed(2)}:s=${seed}`;
  switch (kind) {
    case 'wind': return `${n('pink')},lowpass=f=650,volume='0.55+0.45*sin(2*PI*t/6.3)*sin(2*PI*t/2.1)':eval=frame`;
    case 'sea': return `${n('brown')},bandpass=f=520:w=900,volume='0.45+0.55*pow(0.5+0.5*sin(2*PI*t/9.5),2)':eval=frame`;
    case 'march': return `${n('brown')},lowpass=f=240,volume='if(lt(mod(t,0.58),0.085),1,0.06)':eval=frame`;
    case 'crowd': return `${n('pink')},bandpass=f=900:w=1500,volume='0.5+0.5*abs(sin(2*PI*t/2.7))*abs(sin(2*PI*t/0.93))':eval=frame`;
    case 'arrows': return `${n('white')},bandpass=f=3300:w=1900,volume='exp(-pow(mod(t,1.15)-0.28,2)/0.011)':eval=frame`;
    case 'impact': return `${n('brown')},lowpass=f=140,volume='exp(-t*6)':eval=frame`;
    case 'drums': return `sine=f=66:r=48000:d=${d.toFixed(2)},volume='0.9*exp(-mod(t,1.25)*7)':eval=frame`;
    case 'fire': return `${n('white')},highpass=f=350,lowpass=f=4200,volume='if(gt(random(${seed}),0.965),1,0.03)':eval=frame`;
    case 'hooves': return `${n('brown')},lowpass=f=210,volume='if(lt(mod(t,0.44),0.05)+lt(mod(t+0.13,0.44),0.05),1,0.04)':eval=frame`;
    case 'breath': return `${n('pink')},bandpass=f=1100:w=700,volume='0.35+0.65*pow(0.5+0.5*sin(2*PI*t/3.4),3)':eval=frame`;
    case 'oars': return `${n('brown')},bandpass=f=600:w=500,volume='if(lt(mod(t,1.45),0.35),1-mod(t,1.45)*2.5,0.04)':eval=frame`;
    case 'knock': return `sine=f=170:r=48000:d=${d.toFixed(2)},volume='exp(-t*9)':eval=frame`;
    case 'rumble': return `${n('brown')},lowpass=f=90,afade=t=in:d=0.8,afade=t=out:st=${Math.max(0, d - 1.5).toFixed(2)}:d=1.5`;
    case 'leaves': return `${n('white')},highpass=f=1500,lowpass=f=6000,volume='if(lt(mod(t,0.7),0.12),0.8,0.05)':eval=frame`;
    case 'whip': return `${n('white')},highpass=f=1800,volume='exp(-pow(mod(t,0.9)-0.1,2)/0.0008)':eval=frame`;
    case 'steam': return `${n('white')},bandpass=f=2600:w=2600,volume='0.5+0.3*sin(2*PI*t/1.7)':eval=frame`;
  }
}

/** Cues per shot: offset from the shot start (s), duration (s, trimmed to the shot + 2 s), gain (bed is 0.30). */
export const SFX: Record<string, SfxCue[]> = {
  'V4-001': [{kind: 'wind', at: 0, dur: 12, gain: 0.22}, {kind: 'sea', at: 0, dur: 12, gain: 0.14}, {kind: 'knock', at: 0.15, dur: 0.8, gain: 0.5}],
  'V4-002': [{kind: 'sea', at: 0, dur: 6, gain: 0.18}, {kind: 'steam', at: 0, dur: 6, gain: 0.05}],
  'V4-004': [{kind: 'march', at: 0, dur: 8, gain: 0.18}, {kind: 'wind', at: 0, dur: 6, gain: 0.12}],
  'V4-005': [{kind: 'march', at: 0, dur: 6, gain: 0.42}, {kind: 'crowd', at: 0, dur: 6, gain: 0.12}, {kind: 'hooves', at: 1, dur: 5, gain: 0.14}],
  'V4-006': [{kind: 'wind', at: 0, dur: 8, gain: 0.2}, {kind: 'breath', at: 0, dur: 8, gain: 0.1}],
  'V4-007': [{kind: 'breath', at: 0, dur: 5, gain: 0.16}, {kind: 'knock', at: 0.3, dur: 0.7, gain: 0.25}],
  'V4-008': [{kind: 'wind', at: 0, dur: 6, gain: 0.22}],
  'V4-009': [{kind: 'wind', at: 0, dur: 10, gain: 0.26}, {kind: 'rumble', at: 0, dur: 6, gain: 0.3}],
  'V4-011': [{kind: 'sea', at: 0, dur: 8, gain: 0.3}],
  'V4-012': [{kind: 'sea', at: 0, dur: 9, gain: 0.14}, {kind: 'wind', at: 0, dur: 9, gain: 0.12}],
  'V4-013': [{kind: 'sea', at: 0, dur: 9, gain: 0.22}],
  'V4-016': [{kind: 'march', at: 2, dur: 10, gain: 0.12}, {kind: 'drums', at: 0, dur: 12, gain: 0.08}],
  'V4-017': [{kind: 'sea', at: 0, dur: 10, gain: 0.14}, {kind: 'hooves', at: 1, dur: 8, gain: 0.12}, {kind: 'march', at: 0, dur: 10, gain: 0.14}],
  'V4-018': [{kind: 'sea', at: 0, dur: 9, gain: 0.3}, {kind: 'wind', at: 0, dur: 9, gain: 0.2}, {kind: 'whip', at: 4.5, dur: 2.8, gain: 0.35}],
  'V4-019': [{kind: 'crowd', at: 0, dur: 15, gain: 0.07}],
  'V4-020': [{kind: 'crowd', at: 0, dur: 6, gain: 0.1}, {kind: 'fire', at: 0, dur: 6, gain: 0.08}, {kind: 'hooves', at: 0, dur: 6, gain: 0.05}],
  'V4-021': [{kind: 'wind', at: 0, dur: 11, gain: 0.1}],
  'V4-022': [{kind: 'wind', at: 0, dur: 7, gain: 0.18}],
  'V4-025': [{kind: 'sea', at: 0, dur: 9, gain: 0.18}, {kind: 'knock', at: 1.2, dur: 0.5, gain: 0.15}, {kind: 'knock', at: 3.4, dur: 0.5, gain: 0.15}, {kind: 'knock', at: 5.6, dur: 0.5, gain: 0.15}],
  'V4-027': [{kind: 'drums', at: 0, dur: 10, gain: 0.1}, {kind: 'wind', at: 0, dur: 10, gain: 0.1}],
  'V4-028': [{kind: 'wind', at: 0, dur: 10, gain: 0.18}, {kind: 'hooves', at: 3, dur: 1.5, gain: 0.08}],
  'V4-029': [{kind: 'march', at: 0, dur: 11, gain: 0.14}],
  'V4-030': [{kind: 'march', at: 2, dur: 22, gain: 0.12}, {kind: 'drums', at: 0, dur: 22, gain: 0.06}],
  'V4-031': [{kind: 'march', at: 0, dur: 10, gain: 0.3}, {kind: 'wind', at: 0, dur: 10, gain: 0.12}],
  'V4-032': [{kind: 'steam', at: 0, dur: 9, gain: 0.12}],
  'V4-034': [{kind: 'sea', at: 0, dur: 10, gain: 0.18}, {kind: 'wind', at: 0, dur: 10, gain: 0.12}],
  'V4-036': [{kind: 'fire', at: 0, dur: 10, gain: 0.1}, {kind: 'sea', at: 0, dur: 10, gain: 0.12}, {kind: 'crowd', at: 0, dur: 10, gain: 0.06}],
  'V4-037': [{kind: 'fire', at: 0, dur: 6, gain: 0.08}, {kind: 'wind', at: 0, dur: 6, gain: 0.1}],
  'V4-039': [{kind: 'wind', at: 0, dur: 12, gain: 0.24}, {kind: 'sea', at: 0, dur: 12, gain: 0.12}],
  'V4-042': [{kind: 'wind', at: 0, dur: 18, gain: 0.06}],
  'V4-043': [{kind: 'march', at: 0, dur: 12, gain: 0.34}],
  'V4-044': [{kind: 'wind', at: 0, dur: 9, gain: 0.08}],
  'V4-045': [{kind: 'crowd', at: 0, dur: 7, gain: 0.08}, {kind: 'fire', at: 0, dur: 7, gain: 0.06}, {kind: 'wind', at: 0, dur: 7, gain: 0.1}],
  'V4-046': [{kind: 'hooves', at: 0, dur: 4.5, gain: 0.22}, {kind: 'wind', at: 0, dur: 4.5, gain: 0.14}],
  'V4-047': [{kind: 'fire', at: 0, dur: 16, gain: 0.08}, {kind: 'wind', at: 0, dur: 16, gain: 0.1}],
  'V4-048': [{kind: 'march', at: 0, dur: 9, gain: 0.3}, {kind: 'crowd', at: 0, dur: 9, gain: 0.1}],
  'V4-049': [{kind: 'impact', at: 0.1, dur: 1.2, gain: 0.7}, {kind: 'crowd', at: 0, dur: 6, gain: 0.3}, {kind: 'knock', at: 0.5, dur: 0.6, gain: 0.3}, {kind: 'knock', at: 1.4, dur: 0.6, gain: 0.3}, {kind: 'knock', at: 2.6, dur: 0.6, gain: 0.3}],
  'V4-050': [{kind: 'crowd', at: 0, dur: 6, gain: 0.22}, {kind: 'knock', at: 0.8, dur: 0.6, gain: 0.3}, {kind: 'knock', at: 2.2, dur: 0.6, gain: 0.25}],
  'V4-051': [{kind: 'crowd', at: 0, dur: 5, gain: 0.18}],
  'V4-052': [{kind: 'wind', at: 0, dur: 12, gain: 0.16}, {kind: 'crowd', at: 0, dur: 12, gain: 0.05}],
  'V4-053': [{kind: 'crowd', at: 0, dur: 11, gain: 0.28}, {kind: 'march', at: 0, dur: 11, gain: 0.14}],
  'V4-054': [{kind: 'impact', at: 2.2, dur: 1.2, gain: 0.7}, {kind: 'crowd', at: 0, dur: 12, gain: 0.26}, {kind: 'knock', at: 2.6, dur: 0.6, gain: 0.3}, {kind: 'knock', at: 3.1, dur: 0.6, gain: 0.3}],
  'V4-055': [{kind: 'arrows', at: 0, dur: 9, gain: 0.3}, {kind: 'knock', at: 1.5, dur: 0.5, gain: 0.18}, {kind: 'knock', at: 2.7, dur: 0.5, gain: 0.18}, {kind: 'wind', at: 0, dur: 16, gain: 0.1}],
  'V4-056': [{kind: 'crowd', at: 0, dur: 11, gain: 0.14}, {kind: 'march', at: 0, dur: 11, gain: 0.1}],
  'V4-057': [{kind: 'fire', at: 0, dur: 12, gain: 0.1}, {kind: 'crowd', at: 0, dur: 12, gain: 0.06}, {kind: 'wind', at: 0, dur: 12, gain: 0.08}],
  'V4-059': [{kind: 'wind', at: 0, dur: 7, gain: 0.22}],
  'V4-060': [{kind: 'leaves', at: 0, dur: 9, gain: 0.26}, {kind: 'breath', at: 0, dur: 9, gain: 0.12}, {kind: 'fire', at: 0, dur: 9, gain: 0.06}],
  'V4-061': [{kind: 'wind', at: 0, dur: 5, gain: 0.14}],
  'V4-062': [{kind: 'leaves', at: 0, dur: 6, gain: 0.3}, {kind: 'breath', at: 0, dur: 5, gain: 0.14}, {kind: 'arrows', at: 7, dur: 4, gain: 0.22}],
  'V4-063': [{kind: 'arrows', at: 0, dur: 4, gain: 0.22}, {kind: 'march', at: 0, dur: 8, gain: 0.12}],
  'V4-064': [{kind: 'wind', at: 0, dur: 8, gain: 0.18}],
  'V4-065': [{kind: 'fire', at: 0, dur: 8, gain: 0.2}, {kind: 'march', at: 2, dur: 4, gain: 0.12}],
  'V4-066': [{kind: 'wind', at: 0, dur: 8, gain: 0.2}, {kind: 'fire', at: 0, dur: 8, gain: 0.08}],
  'V4-067': [{kind: 'march', at: 0, dur: 8, gain: 0.22}, {kind: 'sea', at: 0, dur: 8, gain: 0.1}],
  'V4-068': [{kind: 'sea', at: 0, dur: 11, gain: 0.26}, {kind: 'wind', at: 0, dur: 11, gain: 0.1}],
  'V4-069': [{kind: 'wind', at: 0, dur: 9, gain: 0.16}],
  'V4-071': [{kind: 'drums', at: 0, dur: 5, gain: 0.22}, {kind: 'crowd', at: 0, dur: 5, gain: 0.18}],
  'V4-072': [{kind: 'march', at: 0, dur: 5, gain: 0.22}],
  'V4-073': [{kind: 'march', at: 0, dur: 7, gain: 0.34}, {kind: 'breath', at: 0, dur: 8, gain: 0.26}, {kind: 'impact', at: 7.6, dur: 1.4, gain: 0.8}, {kind: 'crowd', at: 7.6, dur: 3, gain: 0.3}],
  'V4-074': [{kind: 'knock', at: 0.3, dur: 0.6, gain: 0.35}, {kind: 'crowd', at: 0, dur: 5, gain: 0.14}],
  'V4-076': [{kind: 'crowd', at: 0, dur: 8, gain: 0.3}, {kind: 'knock', at: 0.9, dur: 0.6, gain: 0.3}, {kind: 'knock', at: 2.3, dur: 0.6, gain: 0.3}, {kind: 'knock', at: 4.1, dur: 0.6, gain: 0.3}],
  'V4-077': [{kind: 'march', at: 0, dur: 5, gain: 0.26}, {kind: 'leaves', at: 0, dur: 4, gain: 0.12}],
  'V4-078': [{kind: 'crowd', at: 0, dur: 12, gain: 0.22}, {kind: 'wind', at: 4, dur: 9, gain: 0.14}],
  'V4-079': [{kind: 'arrows', at: 0, dur: 6, gain: 0.3}, {kind: 'knock', at: 1.2, dur: 0.5, gain: 0.15}],
  'V4-080': [{kind: 'wind', at: 0, dur: 8, gain: 0.1}],
  'V4-082': [{kind: 'wind', at: 0, dur: 11, gain: 0.14}, {kind: 'sea', at: 0, dur: 11, gain: 0.1}],
  'V4-083': [{kind: 'wind', at: 0, dur: 13, gain: 0.24}, {kind: 'sea', at: 0, dur: 13, gain: 0.2}],
  'V4-085': [{kind: 'sea', at: 0, dur: 7, gain: 0.3}, {kind: 'wind', at: 0, dur: 7, gain: 0.22}],
  'V4-086': [{kind: 'oars', at: 0, dur: 7, gain: 0.2}, {kind: 'sea', at: 0, dur: 7, gain: 0.14}],
  'V4-087': [{kind: 'wind', at: 0, dur: 7, gain: 0.14}],
  'V4-088': [{kind: 'fire', at: 0, dur: 6, gain: 0.22}, {kind: 'wind', at: 0, dur: 6, gain: 0.12}],
  'V4-089': [{kind: 'oars', at: 0, dur: 8, gain: 0.26}, {kind: 'sea', at: 0, dur: 8, gain: 0.16}, {kind: 'impact', at: 4.8, dur: 1.2, gain: 0.5}],
  'V4-091': [{kind: 'wind', at: 0, dur: 9, gain: 0.16}],
  'V4-092': [{kind: 'wind', at: 0, dur: 11, gain: 0.18}],
  'V4-093': [{kind: 'wind', at: 0, dur: 10, gain: 0.14}, {kind: 'sea', at: 0, dur: 10, gain: 0.1}],
  'V4-094': [{kind: 'wind', at: 0, dur: 6, gain: 0.08}],
  'V4-096': [{kind: 'wind', at: 0, dur: 10, gain: 0.14}],
  'V4-097': [{kind: 'wind', at: 0, dur: 6, gain: 0.16}],
  'V4-098': [{kind: 'wind', at: 0, dur: 9, gain: 0.2}],
};

/** Music ducks (offset, duration, depth 0..1) for V2: intentional silences and drops. depth 1 = music out. */
export const V2_MUSIC_DROPS: Record<string, [number, number, number][]> = {
  'V4-007': [[0, 3.6, 0.6]], 'V4-048': [[5.6, 1.6, 0.9]], 'V4-049': [[0, 0.4, 0.9]], 'V4-052': [[0, 11, 0.85]], 'V4-066': [[0, 6.4, 0.7]],
  'V4-068': [[0, 3, 1.0]], 'V4-073': [[0, 9.5, 0.92]], 'V4-075': [[0, 1.6, 1.0], [1.6, 3.1, 0.5]], 'V4-094': [[0, 12, 0.8]],
};
/** Shots where the SFX stem is also silenced (total silence beats). */
export const V2_TOTAL_SILENCE: Record<string, [number, number]> = { 'V4-075': [0, 1.6] };
