/**
 * Deterministic high-contrast background for synthetic (fixture) images. A flat colour shrinks to
 * an almost uniform 9×8 grayscale, so every fixture image had nearly the same perceptual hash and
 * the Long Form duplicate gates rejected them all. A 9×8 grid of gray levels seeded per image
 * gives each one its own dHash, so local runs exercise the real gates unchanged.
 */
export function seedFrom(text: string): number {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

export function fixturePatternSvg(seed: number, width: number, height: number): string {
  const cols = 9, rows = 8;
  const cw = width / cols, rh = height / rows;
  let state = seed || 1;
  const next = () => (state = Math.imul(state ^ (state >>> 15), 2246822519) >>> 0, state ^= state >>> 13, state >>> 0);
  let rects = "";
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const level = next() % 2 === 0 ? 40 + (next() % 50) : 170 + (next() % 70);
      rects += `<rect x='${(c * cw).toFixed(1)}' y='${(r * rh).toFixed(1)}' width='${cw.toFixed(1)}' height='${rh.toFixed(1)}' fill='rgb(${level},${level},${level})'/>`;
    }
  }
  return rects;
}
