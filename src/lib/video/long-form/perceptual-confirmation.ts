import sharp from "sharp";

/** A 9x8 gradient hash is only a candidate match, especially in dark water.
 * Confirm it with local structure AND colour before rejecting distinct video.
 * Exact byte/source matches remain independent hard failures. */
export async function comparePerceptualFrames(a: Buffer, b: Buffer) {
  const width = 96, height = 54;
  const pixels = (input: Buffer) => sharp(input).flatten({ background: "black" }).removeAlpha()
    .toColourspace("srgb").resize(width, height, { fit: "fill" }).raw().toBuffer();
  const [x, y] = await Promise.all([pixels(a), pixels(b)]);
  let total = 0, windows = 0, absoluteError = 0;
  for (let i = 0; i < x.length; i++) absoluteError += Math.abs(x[i] - y[i]);
  for (let top = 0; top < height; top += 9) for (let left = 0; left < width; left += 8) {
    for (let channel = 0; channel < 3; channel++) {
      let sx = 0, sy = 0, xx = 0, yy = 0, xy = 0;
      for (let row = top; row < top + 9; row++) for (let col = left; col < left + 8; col++) {
        const i = (row * width + col) * 3 + channel, p = x[i], q = y[i];
        sx += p; sy += q; xx += p * p; yy += q * q; xy += p * q;
      }
      const n = 72, mx = sx / n, my = sy / n;
      const vx = xx / n - mx * mx, vy = yy / n - my * my, covariance = xy / n - mx * my;
      total += ((2 * mx * my + 6.5025) * (2 * covariance + 58.5225)) /
        ((mx * mx + my * my + 6.5025) * (vx + vy + 58.5225));
      windows++;
    }
  }
  const ssim = total / windows, meanAbsoluteError = absoluteError / x.length;
  return { ssim, meanAbsoluteError, duplicate: ssim >= 0.985 && meanAbsoluteError <= 2.5 };
}
