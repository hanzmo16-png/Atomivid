import { canReserve, type LedgerState, type RealModule } from "./ledger";

export type PaidClickGate = {
  real: boolean;
  killSwitch: boolean;
  stopped: boolean;
  ledger: LedgerState | null;
  amountUsd: number | null;
  runCapUsd: number;
  runCommittedUsd: number;
};

export type MediaFacts = {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  audioTracks: number;
  decodeErrors: readonly string[];
};

export type ReelFacts = MediaFacts & {
  subtitlesMeasured: boolean;
  subtitlesPresent: boolean | null;
};

export type VideoPodcastFacts = MediaFacts & {
  lipSyncMeasured: boolean;
  lipSyncPass: boolean | null;
};

export type Acceptance = { ok: boolean; reasons: string[] };

const r2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Common gate immediately before a paid click. It is deliberately pure so the
 * Reels and audiovisual Podcast runners can prove fail-closed behavior before
 * they are wired into the shared worker.
 */
export function campaign320SpendGate(
  module: Extract<RealModule, "reels" | "video-podcast">,
  input: PaidClickGate,
): { ok: boolean; reason: string } {
  if (!input.real) return { ok: false, reason: "Modo gratuito: no se pulsa nada que cueste." };
  if (!input.killSwitch) return { ok: false, reason: "Interruptor real apagado en el momento del clic." };
  if (input.stopped) return { ok: false, reason: "STOP presente en el libro acumulado." };
  if (!input.ledger) return { ok: false, reason: "Sin libro acumulado no se genera." };
  if (input.amountUsd === null || !Number.isFinite(input.amountUsd) || input.amountUsd <= 0) {
    return { ok: false, reason: "La interfaz no mostró un monto verificable." };
  }
  const after = r2(input.runCommittedUsd + input.amountUsd);
  if (after > input.runCapUsd + 1e-9) {
    return { ok: false, reason: `Superaría el tope de la ejecución: USD ${after.toFixed(2)} > ${input.runCapUsd.toFixed(2)}.` };
  }
  return canReserve(input.ledger, module, input.amountUsd);
}

function commonMediaReasons(facts: MediaFacts): string[] {
  const reasons: string[] = [];
  if (facts.durationSeconds === null || facts.durationSeconds <= 0) reasons.push("Duración no medible.");
  if (facts.width === null || facts.height === null || facts.width <= 0 || facts.height <= 0) reasons.push("Dimensiones no medibles.");
  if (facts.audioTracks < 1) reasons.push("El MP4 no contiene audio.");
  if (facts.decodeErrors.length) reasons.push(`Errores de decodificación: ${facts.decodeErrors.join(" · ")}`);
  return reasons;
}

export function acceptRealReel(facts: ReelFacts, requestedSeconds = 30): Acceptance {
  const reasons = commonMediaReasons(facts);
  if (facts.durationSeconds !== null && Math.abs(facts.durationSeconds - requestedSeconds) > 2) {
    reasons.push(`Duración ${facts.durationSeconds.toFixed(2)} s fuera de ${requestedSeconds}±2 s.`);
  }
  if (facts.width !== null && facts.height !== null) {
    const ratio = facts.width / facts.height;
    if (Math.abs(ratio - 9 / 16) > 0.03) reasons.push(`Aspecto ${facts.width}×${facts.height}; se esperaba 9:16.`);
  }
  if (!facts.subtitlesMeasured) reasons.push("Subtítulos no medidos; no se pueden aprobar.");
  else if (facts.subtitlesPresent !== true) reasons.push("No se encontraron subtítulos.");
  return { ok: reasons.length === 0, reasons };
}

export function acceptRealVideoPodcast(facts: VideoPodcastFacts, requestedSeconds: number): Acceptance {
  const reasons = commonMediaReasons(facts);
  const tolerance = Math.max(3, requestedSeconds * 0.08);
  if (facts.durationSeconds !== null && Math.abs(facts.durationSeconds - requestedSeconds) > tolerance) {
    reasons.push(`Duración ${facts.durationSeconds.toFixed(2)} s fuera de la tolerancia de ±${tolerance.toFixed(2)} s.`);
  }
  if (facts.width !== null && facts.height !== null) {
    const ratio = facts.width / facts.height;
    if (Math.abs(ratio - 16 / 9) > 0.03) reasons.push(`Aspecto ${facts.width}×${facts.height}; se esperaba 16:9.`);
  }
  if (!facts.lipSyncMeasured) reasons.push("Sin medición de sincronía labial; no se aprueba por observación subjetiva.");
  else if (facts.lipSyncPass !== true) reasons.push("La sincronía labial medida no pasó.");
  return { ok: reasons.length === 0, reasons };
}
