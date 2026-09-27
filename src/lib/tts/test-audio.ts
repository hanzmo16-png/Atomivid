/**
 * Audio de prueba parecido a una voz (SOLO pruebas y validación local; no
 * es voz real ni inteligible): sílabas de ~4-5 por segundo con envolvente
 * propia, tono que sube y baja por frase, vocales con formantes, algunas
 * consonantes de ruido y pausas entre palabras y frases. Sirve para medir
 * mezcla, sonoridad y picos con una señal de dinámica y espectro de habla,
 * sin proveedor ni gasto.
 */
import { BED_SAMPLE_RATE } from "./music-beds";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOWELS = [
  [730, 1090, 2440], // a
  [530, 1840, 2480], // e
  [270, 2290, 3010], // i
  [570, 840, 2410], // o
  [300, 870, 2240], // u
];

/** Muestras (float, −1..1) de `seconds` segundos de «habla» sintética. */
export function speechLikeSamples(seconds: number, seed = 1, baseF0 = 125): Float32Array {
  const sr = BED_SAMPLE_RATE;
  const out = new Float32Array(Math.round(seconds * sr));
  const rand = mulberry32(seed);
  let t = 0.05;
  let syllableInWord = 0;
  let wordInPhrase = 0;
  const phraseLen = () => 5 + Math.floor(rand() * 6);
  let phrase = phraseLen();
  while (t < seconds - 0.3) {
    const dur = 0.12 + rand() * 0.14;
    const vowel = VOWELS[Math.floor(rand() * VOWELS.length)];
    const progress = wordInPhrase / phrase;
    const f0 = baseF0 * (1.12 - 0.22 * progress) * (0.95 + rand() * 0.1);
    const start = Math.round(t * sr);
    const len = Math.round(dur * sr);
    const amp = 0.22 * (0.7 + rand() * 0.3);
    // Consonante fricativa breve antes de algunas sílabas.
    if (rand() < 0.35) {
      const fl = Math.round(0.05 * sr);
      let prev = 0;
      for (let i = 0; i < fl && start - fl + i >= 0; i++) {
        const n = rand() * 2 - 1;
        const hp = n - prev;
        prev = n;
        out[start - fl + i] += hp * 0.05 * Math.sin((Math.PI * i) / fl);
      }
    }
    const harmonics = Math.min(40, Math.floor(4000 / f0));
    const weights = Array.from({ length: harmonics }, (_, k) => {
      const f = f0 * (k + 1);
      return vowel.reduce((sum, fc, j) => sum + (1 / (1 + ((f - fc) / (60 + 40 * j)) ** 2)) * [1, 0.6, 0.3][j], 0.02) / (k + 1) ** 0.6;
    });
    const norm = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < len && start + i < out.length; i++) {
      const x = i / len;
      const env = Math.sin(Math.PI * x) ** 1.5;
      const time = i / sr;
      let v = 0;
      for (let k = 0; k < harmonics; k++) v += weights[k] * Math.sin(2 * Math.PI * f0 * (k + 1) * time);
      out[start + i] += (v / norm) * env * amp * 3;
    }
    t += dur + 0.02 + rand() * 0.04;
    syllableInWord += 1;
    if (syllableInWord >= 1 + Math.floor(rand() * 3)) {
      syllableInWord = 0;
      wordInPhrase += 1;
      t += 0.06 + rand() * 0.08;
      if (wordInPhrase >= phrase) {
        wordInPhrase = 0;
        phrase = phraseLen();
        t += 0.25 + rand() * 0.2;
      }
    }
  }
  return out;
}

/** WAV PCM 16 bits mono. */
export function monoWav16(samples: Float32Array): Buffer {
  const sr = BED_SAMPLE_RATE;
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}

/**
 * Proveedor de voz simulado para piezas largas: cada fragmento devuelve un
 * trozo distinto de un «banco» de habla sintética, con duración
 * proporcional a sus palabras (≈ 150 palabras por minuto de habla; las
 * pausas entre fragmentos las añade la unión).
 */
export function speechBank(seconds = 90, seed = 7): Float32Array {
  return speechLikeSamples(seconds, seed);
}

export function sliceSpeech(bank: Float32Array, offsetSeconds: number, seconds: number): Float32Array {
  const sr = BED_SAMPLE_RATE;
  const n = Math.max(1, Math.round(seconds * sr));
  const out = new Float32Array(n);
  const start = Math.round(offsetSeconds * sr) % bank.length;
  for (let i = 0; i < n; i++) out[i] = bank[(start + i) % bank.length];
  // Bordes suaves (el proveedor real entrega cada fragmento con inicio y final limpios).
  const edge = Math.min(n / 2, Math.round(0.02 * sr));
  for (let i = 0; i < edge; i++) {
    out[i] *= i / edge;
    out[n - 1 - i] *= i / edge;
  }
  return out;
}
