/**
 * Podcast 3.0 — proveedores SIMULADOS para pruebas y demos (USD 0, sin red). NO son pruebas de proveedores reales.
 * Cada salida lleva la marca «SIMULADO» en pantalla para que nadie la confunda con un render real.
 */
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { ffmpeg } from "./ffmpeg";
import type { VisualAsset } from "./editorial";
import type { AvatarProvider, ImageProvider, Providers, TtsProvider } from "./pipeline";
import { fontFile } from "./compose";

const hasEspeak = () => spawnSync("espeak-ng", ["--version"]).status === 0;
const hashNum = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export type MockCalls = { tts: string[]; avatar: string[]; images: string[]; recreate: string[]; prepare: string[] };
export function mockProviders(opts: { failAvatarTimes?: number; failTtsRejectTimes?: number; usdPer1k?: number; tonesOnly?: boolean; ttsStretch?: number } = {}): Providers & { calls: MockCalls } {
  const calls: MockCalls = { tts: [], avatar: [], images: [], recreate: [], prepare: [] };
  let avatarFails = opts.failAvatarTimes ?? 0, ttsRejects = opts.failTtsRejectTimes ?? 0;
  const usdPer1k = opts.usdPer1k ?? 0.2;
  const tts: TtsProvider = {
    name: "elevenlabs-mock", label: "mock", model: "eleven_multilingual_v2",
    usdFor: (n) => Math.ceil(n / 1000 * usdPer1k * 1e4) / 1e4,
    async synth(text, voiceId, dest) {
      calls.tts.push(`${voiceId}:${text.slice(0, 30)}`);
      if (ttsRejects > 0) { ttsRejects--; const { ProviderRejectedError } = await import("./cost"); throw new ProviderRejectedError("ElevenLabs simulado: 429 (sin cargo)"); }
      const secs = Math.max(1.2, text.length / 15) * (opts.ttsStretch ?? 1);
      const pitch = 90 + (hashNum(voiceId) % 120);
      if (!opts.tonesOnly && hasEspeak()) {
        const wav = dest.replace(/\.mp3$/, ".espeak.wav");
        const r = spawnSync("espeak-ng", ["-v", "es-419", "-s", "165", "-p", String(Math.round(pitch / 4)), "-w", wav, text]);
        if (r.status === 0) { await ffmpeg(["-y", "-v", "error", "-i", wav, "-ar", "44100", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "96k", dest]); return { actualUsd: tts.usdFor(text.length) }; }
      }
      // Voz sintética de prueba: tono con «sílabas» (modulación 4 Hz) y tono distinto por voz.
      await ffmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", `aevalsrc='0.5*sin(2*PI*${pitch}*t)*(0.55+0.45*sin(2*PI*4*t))+0.15*sin(2*PI*${pitch * 2}*t)':s=44100:d=${secs.toFixed(2)}`, "-c:a", "libmp3lame", "-b:a", "96k", dest]);
      return { actualUsd: tts.usdFor(text.length) };
    },
  };
  const colorFor = (ref: string) => ["0x7a3b2e", "0x2e5a7a", "0x3b7a2e", "0x6a2e7a"][hashNum(ref) % 4];
  const avatar: AvatarProvider = {
    name: "heygen-mock", label: "mock", prepareUsd: 0,
    async prepare(ref) { calls.prepare.push(ref); return { ref: `asset:mock-${hashNum(ref)}`, actualUsd: 0 }; },
    usdFor: (s) => Math.ceil(Math.max(1, s) * 0.0385 * 100) / 100,
    async still(ref, dest) {
      await ffmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${colorFor(ref)}:s=480x640:d=1`, "-vf", "drawbox=x=140:y=120:w=200:h=260:c=0xe0b090:t=fill,drawbox=x=190:y=320:w=100:h=14:c=0x401010:t=fill,drawbox=x=100:y=400:w=280:h=240:c=0x202020:t=fill", "-frames:v", "1", dest]);
    },
    async render(ref, audio, seconds, dest) {
      calls.avatar.push(`${ref}:${seconds.toFixed(2)}`);
      if (avatarFails > 0) { avatarFails--; throw new Error("HeyGen simulado: tiempo de espera agotado (estado incierto)"); }
      const font = await fontFile(path.dirname(dest));
      // Boca que se abre y cierra (simulación visual del lip-sync; el real lo hace HeyGen con el audio del turno).
      const vf = `drawbox=x=140:y=120:w=200:h=260:c=0xe0b090:t=fill,drawbox=x=190:y=320:w=100:h=14:c=0x401010:t=fill,drawbox=x=190:y=312:w=100:h=34:c=0x401010:t=fill:enable='lt(mod(t,0.24),0.12)',drawbox=x=100:y=400:w=280:h=240:c=0x202020:t=fill,drawtext=fontfile='${font}':text='AVATAR SIMULADO':fontcolor=white:fontsize=26:x=(w-text_w)/2:y=20`;
      await ffmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${colorFor(ref)}:s=480x640:r=25:d=${seconds.toFixed(3)}`, "-i", audio, "-vf", vf, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", dest]);
      return { actualUsd: avatar.usdFor(seconds) };
    },
  };
  const images: ImageProvider = {
    name: "pexels-mock", label: "mock", recreateUsd: 0.035,
    async search(query) {
      calls.images.push(query);
      const kw = query.split(" ");
      return [0, 1].map((k) => ({ id: `px-${hashNum(query + k)}`, query, kind: k === 1 && hashNum(query) % 3 === 0 ? "archivo" as const : "foto" as const, tags: kw, credit: "Simulado (Pexels mock)" } satisfies VisualAsset));
    },
    async fetch(asset, dest) { await card(dest, `IMAGEN SIMULADA\n${asset.query}`, hashNum(asset.id)); },
    async recreate(prompt, dest) { calls.recreate.push(prompt); await card(dest, `RECREACION SIMULADA\n${prompt.slice(0, 50)}`, hashNum(prompt)); return { actualUsd: 0.035 }; },
  };
  return { tts, avatar, images, calls };
}

async function card(dest: string, text: string, seed: number) {
  const font = await fontFile(path.dirname(dest));
  const f = dest + ".txt"; await writeFile(f, text);
  const hue = seed % 360;
  await ffmpeg(["-y", "-v", "error", "-f", "lavfi", "-i", `gradients=s=1280x720:c0=0x${(0x202020 + (seed % 0x5f5f5f)).toString(16).padStart(6, "0")}:c1=0x101010:d=1`, "-vf", `hue=h=${hue},drawtext=fontfile='${font}':textfile='${f}':fontcolor=white:fontsize=44:x=(w-text_w)/2:y=(h-text_h)/2`, "-frames:v", "1", dest]);
}

/** LLM simulado para el generador conversacional (devuelve un diálogo etiquetado coherente). */
export const mockLlm = async (prompt: string) => {
  const topic = /sobre: «([^»]+)»/.exec(prompt)?.[1] ?? "el tema";
  const [h, g] = /Participantes: ([^ ]+) \(anfitrión\) y ([^ ,.(]+)/.exec(prompt)?.slice(1) ?? ["Ana", "Luis"];
  return [`${h}: Hola a todos, hoy hablamos de ${topic}. Me acompaña ${g}.`, `${g}: Gracias por invitarme. Es un tema fascinante.`, `${h}: ¿Qué es lo primero que deberíamos saber sobre ${topic}?`,
    `${g}: Que conviene separar lo documentado de lo especulativo; hay registros verificables y también mucho mito.`, `${h}: ¡Vaya! No lo había pensado así.`,
    `${g}: Y lo que todavía no sabemos es bastante; por eso hay que ser honestos con las hipótesis.`, `${h}: Gracias, ${g}. Nos escuchamos en el próximo episodio.`, `${g}: Hasta pronto.`].join("\n");
};
