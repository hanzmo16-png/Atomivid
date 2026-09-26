/**
 * Biblioteca de acompañamiento musical de «Texto a voz» (podcast).
 *
 * Solo tres opciones: Sin música, Suspenso y Documental. Cada estado de
 * ánimo tiene dos fondos instrumentales COMPUESTOS POR ESTE CÓDIGO (síntesis
 * determinista: mismas notas, misma semilla, mismo audio). Son obra propia
 * de Atomivid: no provienen de un banco ni de un servicio, no requieren
 * atribución y su uso —incluida la publicación comercial del podcast— no
 * depende de la licencia de un tercero. Las pistas de Eleven Music del
 * banco de Reels NO se usan aquí: sus términos para el plan de la cuenta
 * restringen algunos usos comerciales y no se pudieron verificar en la
 * fuente primaria para publicar podcasts (ver docs/VOICES.md).
 *
 * Cada fondo es un bucle perfecto: se sintetiza en un búfer circular (las
 * colas de cada nota continúan al principio), los osciladores continuos
 * tienen un número entero de ciclos por vuelta y los filtros/reverberación
 * se «calientan» con una vuelta previa. Así se prolonga cualquier duración
 * repitiéndolo sin cortes ni costuras.
 *
 * Lógica pura (sin I/O): devuelve un WAV en memoria.
 */

export type MusicChoice = "none" | "suspense" | "documentary";
export const MUSIC_CHOICES: { value: MusicChoice; label: string; description: string }[] = [
  { value: "none", label: "Sin música", description: "Solo la narración." },
  { value: "suspense", label: "Suspenso", description: "Fondo oscuro y tenso, discreto bajo la voz." },
  { value: "documentary", label: "Documental", description: "Fondo cálido y reflexivo, discreto bajo la voz." },
];

export function parseMusicChoice(raw: unknown): MusicChoice | null {
  return raw === "none" || raw === "suspense" || raw === "documentary" ? raw : null;
}

export type MusicBed = {
  id: string;
  mood: Exclude<MusicChoice, "none">;
  title: string;
  /** Procedencia y licencia (registro obligatorio de toda pista). */
  source: string;
  license: string;
  attribution: string | null;
  loopSeconds: number;
  seed: number;
};

const OWN_WORK = {
  source: "Composición algorítmica de Atomivid (src/lib/tts/music-beds.ts), sintetizada en el worker",
  license: "Obra propia de Atomivid; sin terceros. Uso comercial, publicación y redistribución dentro de los podcasts generados permitidos.",
  attribution: null,
} as const;

export const MUSIC_BEDS: MusicBed[] = [
  { id: "atomivid-suspense-a-v1", mood: "suspense", title: "Niebla baja", loopSeconds: 48, seed: 11, ...OWN_WORK },
  { id: "atomivid-suspense-b-v1", mood: "suspense", title: "Pasillo", loopSeconds: 48, seed: 23, ...OWN_WORK },
  { id: "atomivid-documentary-a-v1", mood: "documentary", title: "Archivo", loopSeconds: 64, seed: 5, ...OWN_WORK },
  { id: "atomivid-documentary-b-v1", mood: "documentary", title: "Horizonte", loopSeconds: 72, seed: 17, ...OWN_WORK },
];

/** Fondo para una pieza: determinista por pieza (un reintento usa el mismo). */
export function pickMusicBed(mood: Exclude<MusicChoice, "none">, jobId: string): MusicBed {
  const options = MUSIC_BEDS.filter((b) => b.mood === mood);
  let h = 2166136261;
  for (const ch of jobId) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return options[h % options.length];
}

export function findMusicBed(id: string | null | undefined): MusicBed | null {
  return MUSIC_BEDS.find((b) => b.id === id) ?? null;
}

// ---------------------------------------------------------------- síntesis

export const BED_SAMPLE_RATE = 44100;
const TAU = Math.PI * 2;

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

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

class Canvas {
  readonly n: number;
  readonly left: Float32Array;
  readonly right: Float32Array;
  constructor(readonly seconds: number) {
    this.n = Math.round(seconds * BED_SAMPLE_RATE);
    this.left = new Float32Array(this.n);
    this.right = new Float32Array(this.n);
  }
  /** Suma circular con paneo de igual potencia (pan 0 = izquierda, 1 = derecha). */
  add(index: number, value: number, pan: number) {
    const i = ((index % this.n) + this.n) % this.n;
    const a = pan * (Math.PI / 2);
    this.left[i] += value * Math.cos(a);
    this.right[i] += value * Math.sin(a);
  }
  /** Frecuencia ajustada para completar un número entero de ciclos por vuelta (osciladores continuos). */
  loopHz(f: number) {
    return Math.max(1, Math.round(f * this.seconds)) / this.seconds;
  }
}

/** Tabla de un ciclo con armónicos (timbre de colchón). */
function wavetable(harmonics: number[], size = 4096): Float32Array {
  const table = new Float32Array(size + 1);
  let peak = 0;
  for (let i = 0; i <= size; i++) {
    let v = 0;
    harmonics.forEach((amp, h) => (v += amp * Math.sin((TAU * (h + 1) * i) / size)));
    table[i] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  for (let i = 0; i <= size; i++) table[i] /= peak || 1;
  return table;
}

function readTable(table: Float32Array, phase: number) {
  const size = table.length - 1;
  const x = (phase - Math.floor(phase)) * size;
  const i = Math.floor(x);
  return table[i] + (table[i + 1] - table[i]) * (x - i);
}

/** Envolvente de coseno alzado: sube en `attack`, se sostiene y baja en `release`. */
function envelope(t: number, attack: number, hold: number, release: number) {
  if (t < 0) return 0;
  if (t < attack) return 0.5 - 0.5 * Math.cos((Math.PI * t) / attack);
  if (t < attack + hold) return 1;
  const r = t - attack - hold;
  if (r < release) return 0.5 + 0.5 * Math.cos((Math.PI * r) / release);
  return 0;
}

function padNote(c: Canvas, table: Float32Array, o: { midi: number; start: number; attack: number; hold: number; release: number; amp: number; pan: number; detuneCents?: number }) {
  const f = hz(o.midi);
  const detune = 2 ** ((o.detuneCents ?? 4) / 1200);
  const total = o.attack + o.hold + o.release;
  const len = Math.round(total * BED_SAMPLE_RATE);
  const start = Math.round(o.start * BED_SAMPLE_RATE);
  let p1 = 0.13;
  let p2 = 0.61;
  const d1 = (f * detune) / BED_SAMPLE_RATE;
  const d2 = f / detune / BED_SAMPLE_RATE;
  for (let i = 0; i < len; i++) {
    const t = i / BED_SAMPLE_RATE;
    const e = envelope(t, o.attack, o.hold, o.release) * o.amp;
    const v = 0.5 * (readTable(table, p1) + readTable(table, p2)) * e;
    c.add(start + i, v, o.pan);
    p1 += d1;
    p2 += d2;
  }
}

/** Nota pulsada tipo piano suave: armónicos que decaen, los agudos antes. */
function pluck(c: Canvas, o: { midi: number; start: number; amp: number; pan: number; decay: number }) {
  const f = hz(o.midi);
  const len = Math.round(o.decay * 4 * BED_SAMPLE_RATE);
  const start = Math.round(o.start * BED_SAMPLE_RATE);
  const partials = [1, 0.42, 0.18, 0.08];
  for (let i = 0; i < len; i++) {
    const t = i / BED_SAMPLE_RATE;
    const attack = Math.min(1, t / 0.006);
    let v = 0;
    partials.forEach((a, h) => (v += a * Math.exp((-t * (1 + h * 1.6)) / o.decay) * Math.sin(TAU * f * (h + 1) * t)));
    c.add(start + i, v * attack * o.amp, o.pan);
  }
}

/** Golpe grave (latido, «boom»): seno con caída de tono y decaimiento rápido. */
function thump(c: Canvas, o: { start: number; amp: number; fromHz: number; toHz: number; decay: number }) {
  const len = Math.round(o.decay * 6 * BED_SAMPLE_RATE);
  const start = Math.round(o.start * BED_SAMPLE_RATE);
  let phase = 0;
  for (let i = 0; i < len; i++) {
    const t = i / BED_SAMPLE_RATE;
    const f = o.toHz + (o.fromHz - o.toHz) * Math.exp(-t / 0.05);
    phase += f / BED_SAMPLE_RATE;
    const e = Math.min(1, t / 0.004) * Math.exp(-t / o.decay);
    c.add(start + i, Math.sin(TAU * phase) * e * o.amp, 0.5);
  }
}

/** Dron continuo con respiración lenta (ciclos enteros por vuelta: bucle sin costura). */
function drone(c: Canvas, table: Float32Array, o: { midi: number; amp: number; pan: number; breathCycles: number; depth: number }) {
  const f = c.loopHz(hz(o.midi));
  for (let i = 0; i < c.n; i++) {
    const t = i / BED_SAMPLE_RATE;
    const breath = 1 - o.depth * (0.5 + 0.5 * Math.cos((TAU * o.breathCycles * t) / c.seconds));
    c.add(i, readTable(table, f * t) * breath * o.amp, o.pan);
  }
}

/** Viento: ruido (periódico por vuelta) por un pasabanda que barre lentamente. */
function wind(c: Canvas, rand: () => number, o: { amp: number; lowHz: number; highHz: number; sweepCycles: number; pan: number }) {
  const noise = new Float32Array(c.n);
  for (let i = 0; i < c.n; i++) noise[i] = rand() * 2 - 1;
  let low = 0;
  let band = 0;
  const q = 0.35;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < c.n; i++) {
      const t = i / BED_SAMPLE_RATE;
      const center = o.lowHz + (o.highHz - o.lowHz) * (0.5 - 0.5 * Math.cos((TAU * o.sweepCycles * t) / c.seconds));
      const fc = 2 * Math.sin((Math.PI * center) / BED_SAMPLE_RATE);
      low += fc * band;
      const high = noise[i] - low - q * band;
      band += fc * high;
      if (pass === 1) c.add(i, band * o.amp, o.pan);
    }
  }
}

/** Reverberación tipo Schroeder por canal, calentada con una vuelta previa para que el bucle no tenga costura. */
function reverb(input: Float32Array, wet: number, spread: number): Float32Array {
  const combs = [1116, 1188, 1277, 1356, 1422, 1491].map((d) => ({ buf: new Float32Array(d + spread), i: 0, store: 0 }));
  const allpasses = [556, 441, 341].map((d) => ({ buf: new Float32Array(d + spread), i: 0 }));
  const out = new Float32Array(input.length);
  const feedback = 0.84;
  const damp = 0.3;
  for (let pass = 0; pass < 2; pass++) {
    for (let n = 0; n < input.length; n++) {
      const x = input[n] * 0.015;
      let acc = 0;
      for (const c of combs) {
        const y = c.buf[c.i];
        c.store = y * (1 - damp) + c.store * damp;
        c.buf[c.i] = x + c.store * feedback;
        c.i = (c.i + 1) % c.buf.length;
        acc += y;
      }
      for (const a of allpasses) {
        const b = a.buf[a.i];
        a.buf[a.i] = acc + b * 0.5;
        a.i = (a.i + 1) % a.buf.length;
        acc = b - acc;
      }
      if (pass === 1) out[n] = input[n] * (1 - wet) + acc * wet * 3;
    }
  }
  return out;
}

/** Pasabajos de un polo (calidez), también calentado con una vuelta previa. */
function lowpass(input: Float32Array, cutoffHz: number): Float32Array {
  const a = 1 - Math.exp((-TAU * cutoffHz) / BED_SAMPLE_RATE);
  const out = new Float32Array(input.length);
  let y = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let n = 0; n < input.length; n++) {
      y += a * (input[n] - y);
      if (pass === 1) out[n] = y;
    }
  }
  return out;
}

const PAD = () => wavetable([1, 0.5, 0.3, 0.16, 0.08, 0.04]);
const DARK = () => wavetable([1, 0.45, 0.28, 0.2, 0.12, 0.09, 0.05, 0.03]);
const GLASS = () => wavetable([1, 0, 0.12, 0, 0.05]);

function composeDocumentary(c: Canvas, rand: () => number, chords: number[][], slot: number) {
  const pad = PAD();
  const slots = Math.round(c.seconds / slot);
  for (let s = 0; s < slots; s++) {
    const chord = chords[s % chords.length];
    const lift = s >= chords.length ? 12 : 0; // segunda vuelta: la voz aguda sube una octava
    chord.forEach((m, k) => {
      const top = k === chord.length - 1;
      padNote(c, pad, { midi: m + (top ? lift : 0), start: s * slot, attack: 2.4, hold: slot - 1.2, release: 3.2, amp: 0.085, pan: 0.2 + 0.6 * (k / (chord.length - 1)) });
    });
    padNote(c, wavetable([1, 0.25]), { midi: chord[0] - 12, start: s * slot, attack: 1.2, hold: slot - 0.6, release: 2, amp: 0.11, pan: 0.5, detuneCents: 1 });
    // Melodía escasa de notas del acorde; silencios frecuentes para no competir con la voz.
    for (let beat = 0; beat < slot; beat += 2) {
      if (rand() < 0.45) continue;
      const tone = chord[1 + Math.floor(rand() * (chord.length - 1))] + 12;
      pluck(c, { midi: tone, start: s * slot + beat + rand() * 0.3, amp: 0.07, pan: 0.3 + rand() * 0.4, decay: 0.9 });
    }
  }
}

function renderBed(bed: MusicBed): { left: Float32Array; right: Float32Array } {
  const c = new Canvas(bed.loopSeconds);
  const rand = mulberry32(bed.seed);
  if (bed.id === "atomivid-documentary-a-v1") {
    // Re menor: Dm – Bb – F – C, 8 s por acorde, dos vueltas con variación.
    composeDocumentary(c, rand, [[50, 57, 62, 65], [46, 58, 62, 65], [53, 57, 60, 65], [48, 55, 60, 64]], 8);
  } else if (bed.id === "atomivid-documentary-b-v1") {
    // Mi menor / Sol: Em – C – G – D, 9 s por acorde.
    composeDocumentary(c, rand, [[52, 59, 64, 67], [48, 60, 64, 67], [43, 59, 62, 67], [50, 57, 62, 66]], 9);
  } else if (bed.id === "atomivid-suspense-a-v1") {
    const dark = DARK();
    drone(c, dark, { midi: 33, amp: 0.2, pan: 0.5, breathCycles: 3, depth: 0.35 }); // La grave
    drone(c, dark, { midi: 40, amp: 0.09, pan: 0.35, breathCycles: 2, depth: 0.5 }); // quinta
    for (let s = 0; s < 2; s++) {
      padNote(c, GLASS(), { midi: 69, start: s * 24 + 4, attack: 6, hold: 4, release: 6, amp: 0.03, pan: 0.75 });
      padNote(c, GLASS(), { midi: 70, start: s * 24 + 6, attack: 6, hold: 3, release: 6, amp: 0.024, pan: 0.25 }); // segunda menor
    }
    padNote(c, dark, { midi: 51, start: 30, attack: 5, hold: 3, release: 6, amp: 0.05, pan: 0.6 }); // trítono
    for (let w = 0; w < 2; w++) {
      for (let b = 0; b < 8; b++) {
        const at = w * 24 + 14 + b * 1.1;
        thump(c, { start: at, amp: 0.16, fromHz: 70, toHz: 44, decay: 0.09 });
        thump(c, { start: at + 0.3, amp: 0.1, fromHz: 64, toHz: 42, decay: 0.08 });
      }
    }
    wind(c, rand, { amp: 0.16, lowHz: 260, highHz: 900, sweepCycles: 2, pan: 0.5 });
  } else {
    const dark = DARK();
    drone(c, dark, { midi: 38, amp: 0.18, pan: 0.5, breathCycles: 24, depth: 0.28 }); // Re con pulso lento
    drone(c, dark, { midi: 45, amp: 0.07, pan: 0.6, breathCycles: 4, depth: 0.5 });
    padNote(c, GLASS(), { midi: 74, start: 2, attack: 7, hold: 8, release: 7, amp: 0.025, pan: 0.3 });
    padNote(c, GLASS(), { midi: 75, start: 26, attack: 7, hold: 6, release: 7, amp: 0.022, pan: 0.7 });
    for (let t = 0; t < c.seconds; t += 3) {
      if (rand() < 0.4) continue;
      pluck(c, { midi: 93 + Math.floor(rand() * 3), start: t + rand() * 0.5, amp: 0.012, pan: rand(), decay: 0.05 });
    }
    for (let t = 0; t < c.seconds; t += 12) thump(c, { start: t + 1, amp: 0.2, fromHz: 58, toHz: 38, decay: 0.5 });
    wind(c, rand, { amp: 0.1, lowHz: 400, highHz: 1400, sweepCycles: 1, pan: 0.5 });
  }
  const warm = bed.mood === "documentary" ? 3200 : 2600;
  return { left: reverb(lowpass(c.left, warm), 0.32, 0), right: reverb(lowpass(c.right, warm), 0.32, 23) };
}

/** WAV PCM 16 bits estéreo a partir de dos canales (normaliza el pico a `peak`). */
export function encodeWav16(left: Float32Array, right: Float32Array, peak = 0.5): Buffer {
  let max = 0;
  for (let i = 0; i < left.length; i++) max = Math.max(max, Math.abs(left[i]), Math.abs(right[i]));
  const scale = max > 0 ? peak / max : 0;
  const frames = left.length;
  const buf = Buffer.alloc(44 + frames * 4);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + frames * 4, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(BED_SAMPLE_RATE, 24);
  buf.writeUInt32LE(BED_SAMPLE_RATE * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(left[i] * scale * 32767))), 44 + i * 4);
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(right[i] * scale * 32767))), 46 + i * 4);
  }
  return buf;
}

/** El fondo como WAV en bucle perfecto (misma entrada → mismos bytes). */
export function renderMusicBedWav(bed: MusicBed): Buffer {
  const { left, right } = renderBed(bed);
  return encodeWav16(left, right);
}
