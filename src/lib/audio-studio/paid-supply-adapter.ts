import type { StudioVoiceMode } from "./voice";

/**
 * Audio projects are Storage documents, not video_requests rows. The existing atomic
 * pi_reserve_job_supply RPC cannot reserve an Audio job. A per-segment ledger alone
 * would not protect the whole authorization, nor make spentUsd replay atomic.
 * The new paid-supply-port contract is required for uncached real TTS.
 * Without its verified atomic reservation, never submit uncached real TTS. Do not create
 * a synthetic video request, another ledger, or a production/environment bypass.
 */
export const AUDIO_WHOLE_JOB_SUPPLY = "BLOCKED_AUDIO_JOB_RESERVATION_UNAVAILABLE" as const;

export class AudioPaidSupplyBlockedError extends Error {
  readonly code = AUDIO_WHOLE_JOB_SUPPLY;
  constructor() {
    super("La voz real está en espera de una reserva de recursos verificada. Esta intervención no se envió al proveedor ni generó un cargo nuevo. La voz ya guardada se conserva; podrás reanudar cuando esté disponible el control de recursos.");
    this.name = "AudioPaidSupplyBlockedError";
  }
}

/** Cache hits never enter this gate. Only the two existing local adapters may synthesize. */
export function assertAudioSegmentSupplyAdmission(mode: StudioVoiceMode, providerName: string): void {
  if (mode === "fixture" && providerName === "fixture-espeak") return;
  if (mode === "demo" && providerName === "demo-espeak") return;
  throw new AudioPaidSupplyBlockedError();
}
