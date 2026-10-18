/**
 * Id of a new video request (PR #149, corrección 2, 2026-10-18). Server only.
 *
 * The browser sends a DRAFT KEY (draft-key.ts): one per draft, shared by every tab of the same browser through
 * localStorage, rotated only after the server confirmed the request exists. The server — never the browser —
 * turns it into the request id, bound to the verified user and to WHAT is asked (the intent fingerprint):
 *   - double click, browser resend, a second tab with the same draft, a lost response re-submitted: same user,
 *     same key, same intent → same id → one row (the primary key is the authority; 23505 means «already there»);
 *   - a deliberate new video (key rotated after success) or a different intent in another tab → another id.
 * The browser cannot pick an arbitrary id (nor probe someone else's): the id is a hash that includes user.id.
 */
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@/lib/production-intelligence/canonical";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Fields that define what the customer asked for. Files count by name, size and type (never their bytes). */
const INTENT_FIELDS = ["mode", "topic", "style", "duration_seconds", "language", "script_choice", "own_script_text", "adapt_accepted",
  "narration_source", "avatar_tts_text", "existing_avatar_id", "avatar_name", "avatar_photo", "recorded_audio"] as const;

export function intentFingerprint(formData: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of INTENT_FIELDS) {
    const v = formData.get(k);
    if (v === null) continue;
    out[k] = typeof v === "string" ? v.trim() : { name: v.name, size: v.size, type: v.type };
  }
  return out;
}

/** Deterministic UUID (version 8, RFC 9562) from the user, the draft key and the intent. */
export function draftRequestId(userId: string, draftKey: string, intent: Record<string, unknown>): string {
  const h = createHash("sha256").update(canonicalJson({ v: 1, userId, draftKey: draftKey.toLowerCase(), intent })).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The request id for this submission; without a valid draft key (old tab, no storage) a fresh one, as before. */
export function requestIdForSubmission(userId: string, formData: FormData): { requestId: string; draftKey: string | null } {
  const draftKey = String(formData.get("submission_id") ?? "");
  if (!UUID.test(draftKey)) return { requestId: randomUUID(), draftKey: null };
  return { requestId: draftRequestId(userId, draftKey, intentFingerprint(formData)), draftKey: draftKey.toLowerCase() };
}

/** Where a confirmed creation lands: the draft key travels back so the browser can rotate it (and only it). */
export function createdUrl(draftKey: string | null): string {
  return draftKey ? `/dashboard?created=1&draft=${draftKey}` : "/dashboard?created=1";
}
