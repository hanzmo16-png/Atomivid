/**
 * Puerta de seguridad central de la producción real de Long Form. El
 * orquestador (scripts/produce-long-form-video.ts) SIEMPRE pasa por
 * `resolveLongFormProviders()` para obtener sus proveedores — nunca
 * importa un proveedor "real" directamente. Esto hace que el modo
 * "simulation" sea imposible de romper por accidente: ignora POR
 * COMPLETO cualquier variable de entorno de proveedor (VOICE_PROVIDER,
 * IMAGE_PROVIDER, etc.), así que aunque el entorno tenga claves reales
 * configuradas, simulation jamás las toca.
 */
import { fixtureVoiceProvider } from "@/lib/providers/voice/fixture";
import { getVoiceProvider } from "@/lib/providers/voice";
import { fixtureFootageProvider } from "@/lib/providers/footage/fixture";
import { getFootageProvider } from "@/lib/providers/footage";
import { fixtureMusicProvider } from "@/lib/providers/music/fixture";
import { getMusicProvider } from "@/lib/providers/music";
import { fixtureImageProvider } from "@/lib/providers/image/fixture";
import { getImageProvider } from "@/lib/providers/image";
import type { FootageProvider, ImageProvider, MusicProvider, VoiceProvider } from "@/lib/providers/types";

export type LongFormRunMode = "simulation" | "real";

/**
 * Valor EXACTO requerido (no "1"/"true") — deliberadamente poco propenso a
 * quedar activado sin querer en un .env compartido o copiado de otra
 * variable booleana.
 */
const REAL_RUN_CONFIRM_VALUE = "YES_SPEND_REAL_MONEY";

export class LongFormRealModeNotConfirmedError extends Error {
  constructor() {
    super(
      `Modo real de Long Form solicitado sin confirmación explícita. Define ` +
        `LONG_FORM_REAL_RUN_CONFIRM=${REAL_RUN_CONFIRM_VALUE} para continuar — esto ` +
        `va a consumir créditos reales (Anthropic/ElevenLabs/OpenAI/etc.), nunca se activa solo.`,
    );
    this.name = "LongFormRealModeNotConfirmedError";
  }
}

/**
 * A diferencia de Shorts (donde getVoiceProvider()/getImageProvider()/etc.
 * solo exigen credenciales reales cuando isProductionRuntime() es true —
 * correcto para una app web, donde "dev local sin clave" debe poder usar
 * fixtures), el orquestador de Long Form se ejecuta típicamente como script
 * CLI local, NUNCA con NODE_ENV=production/VERCEL=1. Sin este chequeo
 * adicional, `--mode=real` + LONG_FORM_REAL_RUN_CONFIRM podría resolver en
 * silencio a proveedores fixture si falta una credencial — produciendo un
 * "video real" que en realidad es contenido de fixture, sin ningún error.
 * Esta clase de error hace que ESO sea estructuralmente imposible: en modo
 * real, cualquier proveedor que resuelva a fixture (por credencial
 * faltante) detiene la ejecución con un mensaje explícito.
 */
export class LongFormRealProviderMissingError extends Error {
  constructor(stage: string, envVarHint: string) {
    super(
      `Modo real de Long Form: el proveedor de ${stage} resolvió a "fixture" en vez de a un ` +
        `proveedor real. Falta configurar ${envVarHint}. En modo real, Long Form nunca debe usar ` +
        `contenido de fixture en silencio — o se resuelve el proveedor real, o la ejecución se detiene aquí.`,
    );
    this.name = "LongFormRealProviderMissingError";
  }
}

export function isRealModeConfirmed(env: Record<string, string | undefined> = process.env): boolean {
  return env.LONG_FORM_REAL_RUN_CONFIRM === REAL_RUN_CONFIRM_VALUE;
}

export function assertRealModeConfirmed(env: Record<string, string | undefined> = process.env): void {
  if (!isRealModeConfirmed(env)) throw new LongFormRealModeNotConfirmedError();
}

export type LongFormProviderSet = {
  voiceProvider: VoiceProvider;
  footageProvider: FootageProvider;
  musicProvider: MusicProvider;
  imageProvider: ImageProvider;
};

/**
 * "simulation" (modo por defecto en todo el orquestador): SIEMPRE
 * fixtures, sin excepción, sin leer ninguna env var de proveedor.
 *
 * "real": reutiliza los mismos getVoiceProvider()/getFootageProvider()/
 * getMusicProvider()/getImageProvider() que ya usa Shorts (generate-video.ts)
 * — ningún proveedor nuevo, misma lógica real-vs-fixture ya validada — pero
 * exige la confirmación explícita de arriba antes de resolver nada.
 */
export function resolveLongFormProviders(
  mode: LongFormRunMode,
  env: Record<string, string | undefined> = process.env,
): LongFormProviderSet {
  if (mode === "simulation") {
    return {
      voiceProvider: fixtureVoiceProvider,
      footageProvider: fixtureFootageProvider,
      musicProvider: fixtureMusicProvider,
      imageProvider: fixtureImageProvider,
    };
  }

  assertRealModeConfirmed(env);
  const providers: LongFormProviderSet = {
    voiceProvider: getVoiceProvider(),
    footageProvider: getFootageProvider(),
    musicProvider: getMusicProvider(),
    imageProvider: getImageProvider(),
  };

  if (providers.voiceProvider.name === "fixture") {
    throw new LongFormRealProviderMissingError("voz", "ELEVENLABS_API_KEY");
  }
  if (providers.footageProvider.name === "fixture") {
    throw new LongFormRealProviderMissingError("footage", "PEXELS_API_KEY");
  }
  if (providers.imageProvider.name === "fixture") {
    throw new LongFormRealProviderMissingError("imagen", "OPENAI_API_KEY (o IMAGE_PROVIDER=openai)");
  }
  if (providers.musicProvider.name === "fixture") {
    throw new LongFormRealProviderMissingError(
      "música",
      "MUSIC_TRACK_URL / MUSIC_TRACK_URLS (biblioteca curada, gratis) o BEATOVEN_API_KEY",
    );
  }

  return providers;
}

/**
 * Nombres de proveedor SIN costo marginal por uso — coincide con
 * src/lib/billing/pricing.ts ("Footage (Pexels): gratis, sin costo por
 * request"; música curada "gratis... el gasto ya se pagó una vez al
 * generarla"). Cualquier otro nombre (elevenlabs, openai, beatoven, ...)
 * cuenta como API pagada.
 */
const FREE_PROVIDER_NAMES: Record<keyof LongFormProviderSet, ReadonlySet<string>> = {
  voiceProvider: new Set(["fixture"]),
  footageProvider: new Set(["fixture", "pexels-video-first"]),
  musicProvider: new Set(["fixture", "curated-library"]),
  imageProvider: new Set(["fixture"]),
};

/** Verificación real (no una constante) — deriva de qué proveedores se resolvieron de verdad, no de si son "fixture" literalmente (Pexels y la biblioteca curada son reales pero gratis). */
export function computePaidApisCalled(providers: LongFormProviderSet): boolean {
  return (Object.keys(providers) as (keyof LongFormProviderSet)[]).some(
    (key) => !FREE_PROVIDER_NAMES[key].has(providers[key].name),
  );
}
