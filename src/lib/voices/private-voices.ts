/**
 * Private voices (clones the ElevenLabs account owns) are content of one person. They are visible and usable
 * only by the confirmed accounts the operator grants in server configuration — never in public code and never
 * to another account. Format (server env, not a secret):
 *   PRIVATE_VOICE_GRANTS="<voiceId>=<email>[|<email>...];<voiceId2>=<email>"
 */
import type { AccountVoice } from "@/lib/podcast/voices";

export type VoiceViewer = { id?: string | null; email?: string | null; email_confirmed_at?: string | null } | null | undefined;

const VOICE_ID = /^[A-Za-z0-9]{8,64}$/;

export function parsePrivateVoiceGrants(raw: string | undefined): Map<string, Set<string>> {
  const grants = new Map<string, Set<string>>();
  for (const entry of (raw ?? "").split(";")) {
    const [id, emails] = entry.split("=").map(s => s?.trim() ?? "");
    if (!id || !emails || !VOICE_ID.test(id)) continue;
    const set = grants.get(id) ?? new Set<string>();
    for (const e of emails.split("|")) if (/^[^\s@]+@[^\s@]+$/.test(e.trim())) set.add(e.trim().toLowerCase());
    if (set.size) grants.set(id, set);
  }
  return grants;
}

/** A voice is private when the account owns it and it is not a stock voice (instant or professional clone). */
export function isPrivateVoice(v: Pick<AccountVoice, "category" | "isOwner">): boolean {
  return v.category !== "premade" && (v.isOwner === true || v.category === "cloned");
}

export function canUsePrivateVoice(voiceId: string, viewer: VoiceViewer, env: Record<string, string | undefined> = process.env): boolean {
  const email = viewer?.email?.trim().toLowerCase();
  if (!email || !viewer?.email_confirmed_at) return false;
  return parsePrivateVoiceGrants(env.PRIVATE_VOICE_GRANTS).get(voiceId)?.has(email) ?? false;
}

/** Drops private voices the viewer is not granted. Stock and shared library voices are unaffected. */
export function visibleVoices(voices: AccountVoice[], viewer: VoiceViewer, env: Record<string, string | undefined> = process.env): AccountVoice[] {
  return voices.filter(v => !isPrivateVoice(v) || canUsePrivateVoice(v.voiceId, viewer, env));
}

/** Whether the provider reports the voice trained/usable for the TTS model in use. Instant clones work on all models. */
export function supportsModel(v: Pick<AccountVoice, "category" | "models">, model: string): boolean {
  if (v.category === "cloned" || v.category === "premade") return true;
  return (v.models ?? []).includes(model);
}
