/**
 * SOLO PRUEBAS LOCALES: proveedor de voz con nombre «elevenlabs» para que el gate REAL de pagos se ejecute,
 * pero que sintetiza con espeak-ng (gratis, sin red). Cada voice_id obtiene una voz espeak DISTINTA y fija.
 * Registra cada llamada (voz, texto, velocidad, ajustes) para probar qué se habría enviado. Nunca en producción.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { VoiceProvider } from "@/lib/providers/types";

export type EspeakCall = { voiceId: string; text: string; speed?: number; settings: unknown };
const PROFILES = [["-v", "es-419", "-p", "28"], ["-v", "es+f3", "-p", "65"], ["-v", "es", "-p", "45"]];

export function espeakVoice(voiceId: string, settings: unknown, log: EspeakCall[], profileOf: (voiceId: string) => number, fail?: (call: EspeakCall) => void): VoiceProvider {
  if (process.env.VERCEL || process.env.NODE_ENV === "production") throw new Error("espeak-provider es solo para pruebas locales");
  return {
    name: "elevenlabs",
    synthesize: async (text, _language, speed) => {
      const call = { voiceId, text, speed, settings };
      log.push(call);
      fail?.(call);
      const dir = mkdtempSync(path.join(tmpdir(), "espk-")), raw = path.join(dir, "r.wav"), wav = path.join(dir, "o.wav");
      try {
        execFileSync("espeak-ng", [...PROFILES[profileOf(voiceId) % PROFILES.length], "-s", String(Math.round(165 * (speed ?? 1))), "-w", raw, text]);
        execFileSync("ffmpeg", ["-y", "-v", "error", "-i", raw, "-ar", "48000", "-ac", "1", "-bitexact", wav]);
        const audioBuffer = readFileSync(wav), dur = (audioBuffer.length - 44) / 96000;
        const ws = text.split(/\s+/).filter(Boolean), step = dur / Math.max(1, ws.length);
        return { audioBuffer, durationSeconds: dur, mimeType: "audio/wav", extension: "wav", words: ws.map((w, i) => ({ text: w, startSeconds: i * step, endSeconds: (i + 1) * step })) };
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  };
}
