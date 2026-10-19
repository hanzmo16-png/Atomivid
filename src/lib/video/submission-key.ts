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
import { createHash } from "node:crypto";
import { canonicalJson } from "@/lib/production-intelligence/canonical";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Fields that define what the customer asked for. Files count by the SHA-256 of their bytes, size and type (C2
 * residual C): two different photos or recordings with the same name and size are different intents. The hash is
 * computed here, on the server, and never stored nor sent anywhere; the files are bounded by the form's limits.
 */
// repeat_intent is NOT part of the intent: it only selects the ordinal.
const INTENT_FIELDS = ["mode", "topic", "style", "duration_seconds", "language", "script_choice", "own_script_text", "adapt_accepted",
  "narration_source", "avatar_tts_text", "existing_avatar_id", "avatar_name", "avatar_photo", "recorded_audio"] as const;

export async function intentFingerprint(formData: FormData): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const k of INTENT_FIELDS) {
    const v = formData.get(k);
    if (v === null) continue;
    out[k] = typeof v === "string" ? v.trim()
      : { sha256: createHash("sha256").update(Buffer.from(await v.arrayBuffer())).digest("hex"), size: v.size, type: v.type };
  }
  return out;
}

/** Deterministic UUID (version 8, RFC 9562) from the user, the draft key and the intent. */
export function draftRequestId(userId: string, draftKey: string, intent: Record<string, unknown>): string {
  const h = createHash("sha256").update(canonicalJson({ v: 1, userId, draftKey: draftKey.toLowerCase(), intent })).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * T46 D1: the request id no longer depends on the browser. It is derived on the server from the verified user and the
 * intent (every field the customer chose, files by their bytes) and an ordinal n:
 *   - a normal submit uses n = 0, so two tabs, a resend, a lost response or a browser without localStorage/Web Locks
 *     all map the same intent to the SAME id, and the primary key (23505) is the authority — no time window involved;
 *   - a deliberate second video with the same data is an explicit choice («Crear otro video igual», field
 *     `repeat_intent=on`): the server takes the first ordinal whose id does not exist for this user. Two concurrent
 *     explicit repeats pick the same ordinal and still collide on the primary key.
 * The browser's draft key is kept only to rotate the client draft after a confirmed creation; it never selects the id.
 */
export const MAX_REPEAT_ORDINAL = 50;

export function intentRequestId(userId: string, intent: Record<string, unknown>, ordinal: number): string {
  return draftRequestId(userId, `intent-v2:${ordinal}`, intent);
}

export async function requestIdForSubmission(userId: string, formData: FormData,
  existingIds: (candidates: string[]) => Promise<Set<string>> = async () => new Set()):
  Promise<{ requestId: string | null; draftKey: string | null; repeat: boolean }> {
  const raw = String(formData.get("submission_id") ?? "");
  const draftKey = UUID.test(raw) ? raw.toLowerCase() : null;
  const intent = await intentFingerprint(formData);
  const repeat = formData.get("repeat_intent") === "on";
  if (!repeat) return { requestId: intentRequestId(userId, intent, 0), draftKey, repeat };
  const candidates = Array.from({ length: MAX_REPEAT_ORDINAL }, (_, n) => intentRequestId(userId, intent, n));
  const taken = await existingIds(candidates);
  return { requestId: candidates.find(c => !taken.has(c)) ?? null, draftKey, repeat };
}

/** Where a confirmed creation lands: the draft key travels back so the browser can rotate it (and only it). */
export function createdUrl(draftKey: string | null, existing = false): string {
  const q = `${draftKey ? `&draft=${draftKey}` : ""}${existing ? "&existing=1" : ""}`;
  return `/dashboard?created=1${q}`;
}

/** Back to the form with a message; with `resetDraft`, the form starts a new draft (only after a stale claim). */
export function formErrorUrl(message: string, resetDraft?: string | null): string {
  return `/dashboard/new?error=${encodeURIComponent(message)}${resetDraft ? `&reset=${resetDraft}` : ""}`;
}
