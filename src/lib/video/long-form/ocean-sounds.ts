/** Deterministic editorial sound design, not recordings of a real dive. */
export type OceanSound = { id: string; seconds: number; kind: "ambience" | "sonar" };
const sounds: OceanSound[] = [
  { id: "atomivid-ocean-ambience-v1", seconds: 32, kind: "ambience" },
  { id: "atomivid-ocean-sonar-v1", seconds: 3, kind: "sonar" },
];
export const findOceanSound = (id: string) => sounds.find(s => s.id === id);

export function renderOceanSound(sound: OceanSound): Buffer {
  const rate = 44100;
  const samples = Math.round(sound.seconds * rate);
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const t = i / rate;
    const tau = Math.PI * 2;
    // Whole-number cycles make the ambience loop continuous.
    const value = sound.kind === "ambience"
      ? (0.10 * Math.sin(tau * 55 * t) + 0.05 * Math.sin(tau * 83 * t) + 0.025 * Math.sin(tau * 137 * t)) * (0.8 + 0.2 * Math.cos(tau * t / sound.seconds))
      : 0.35 * Math.sin(tau * 920 * t) * Math.min(1, t / 0.02) * Math.exp(-3.3 * t) * Math.min(1, (sound.seconds - t) / 0.08);
    wav.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return wav;
}
