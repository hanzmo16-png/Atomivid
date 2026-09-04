/**
 * Genera un WAV (PCM 16-bit mono) con un tono simple, en JS puro sin
 * dependencias ni llamadas de red. Usado por los proveedores fixture de
 * voz y música para producir audio real y reproducible en el pipeline
 * de prueba.
 */
export function generateToneWav({
  durationSeconds,
  frequencyHz = 220,
  sampleRate = 44100,
  amplitude = 0.2,
}: {
  durationSeconds: number;
  frequencyHz?: number;
  sampleRate?: number;
  amplitude?: number;
}): Buffer {
  const numSamples = Math.max(1, Math.round(durationSeconds * sampleRate));
  const dataSize = numSamples * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  const fadeSamples = Math.min(numSamples, Math.round(sampleRate * 0.02));
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let sample = Math.sin(2 * Math.PI * frequencyHz * t) * amplitude;

    // Fade in/out para evitar clicks al inicio/fin del tono.
    if (i < fadeSamples) sample *= i / fadeSamples;
    if (i > numSamples - fadeSamples) sample *= (numSamples - i) / fadeSamples;

    buffer.writeInt16LE(Math.round(sample * 32767), 44 + i * 2);
  }

  return buffer;
}
