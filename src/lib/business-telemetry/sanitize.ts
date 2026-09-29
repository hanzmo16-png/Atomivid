/**
 * Business Telemetry V0 — privacy / data minimisation. Runs BEFORE schema validation on every
 * metadata object: forbidden key names (secrets, credentials, card data, raw identifiers) and
 * secret-looking values are refused outright, never silently dropped. The per-event strict
 * schemas in taxonomy.ts are the allowlist; this file is the second, key-independent guard.
 */
export type SanitizeResult = { ok: true; value: Record<string, unknown> } | { ok: false; reason: "forbidden_metadata" | "secret_like_value"; detail: string };

/** Key names that never belong in telemetry, whatever the event. */
export const FORBIDDEN_KEY_PATTERN = /(passw(or)?d|secret|token|api[_-]?key|apikey|authorization|auth[_-]?header|cookie|session[_-]?id|private[_-]?key|credential|card[_-]?number|cvv|cvc|\bpan\b|iban|ssn|ip[_-]?address|\bip\b|e-?mail|phone|street|address|refresh|access[_-]?key|client[_-]?secret|signature|bearer)/i;
const KEY_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_STRING = 500;
const MAX_KEYS = 60;
const MAX_DEPTH = 3;

/** Values that look like credentials or bearer material, regardless of the key they arrive under. */
export const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^sk-[A-Za-z0-9_-]{8,}/,               // OpenAI-style keys
  /^(sk|pk|rk|whsec)_(live|test)_/,      // Stripe keys / webhook secrets
  /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /^bearer\s+\S+/i,
  /^basic\s+[A-Za-z0-9+/=]{8,}/i,
  /^AKIA[0-9A-Z]{12,}/,                  // AWS access key id
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /^gh[pousr]_[A-Za-z0-9]{20,}/,         // GitHub tokens
  /^xox[baprs]-/,                        // Slack tokens
  /^AIza[0-9A-Za-z_-]{30,}/,             // Google API keys
  /^ya29\.[0-9A-Za-z_-]+/,               // Google OAuth access tokens
  /^1\/\/[0-9A-Za-z_-]{20,}/,            // Google refresh tokens
  /^[0-9]{13,19}$/,                      // card-number-like digit runs
];

/** A 64-hex sha256 is a legitimate content checksum; other long random-looking blobs are not welcome. */
export function looksSecret(value: string): boolean {
  const v = value.trim();
  if (SECRET_VALUE_PATTERNS.some((p) => p.test(v))) return true;
  if (/^[a-f0-9]{64}$/i.test(v)) return false;
  if (/^[A-Fa-f0-9]{32,}$/.test(v)) return true;
  if (v.length >= 40 && !/\s/.test(v) && /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v) && /^[A-Za-z0-9+/=_-]+$/.test(v)) return true;
  return false;
}

export function sanitizeMetadata(meta: unknown): SanitizeResult {
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return { ok: false, reason: "forbidden_metadata", detail: "metadata must be a plain object" };
  let keys = 0;
  const walk = (o: Record<string, unknown>, path: string, depth: number): SanitizeResult | null => {
    if (depth > MAX_DEPTH) return { ok: false, reason: "forbidden_metadata", detail: `${path || "metadata"}: nesting deeper than ${MAX_DEPTH}` };
    for (const [k, v] of Object.entries(o)) {
      const p = path ? `${path}.${k}` : k;
      if (++keys > MAX_KEYS) return { ok: false, reason: "forbidden_metadata", detail: `more than ${MAX_KEYS} keys` };
      if (!KEY_SHAPE.test(k)) return { ok: false, reason: "forbidden_metadata", detail: `${p}: key must match ${KEY_SHAPE}` };
      if (FORBIDDEN_KEY_PATTERN.test(k)) return { ok: false, reason: "forbidden_metadata", detail: `${p}: forbidden key` };
      if (typeof v === "string") {
        if (v.length > MAX_STRING) return { ok: false, reason: "forbidden_metadata", detail: `${p}: string longer than ${MAX_STRING}` };
        if (looksSecret(v)) return { ok: false, reason: "secret_like_value", detail: `${p}: value looks like a credential` };
      } else if (typeof v === "number") {
        if (!Number.isFinite(v)) return { ok: false, reason: "forbidden_metadata", detail: `${p}: non-finite number` };
      } else if (Array.isArray(v)) {
        for (const [i, item] of v.entries()) {
          if (typeof item === "string" && looksSecret(item)) return { ok: false, reason: "secret_like_value", detail: `${p}[${i}]: value looks like a credential` };
          if (item !== null && typeof item === "object") { const r = walk(item as Record<string, unknown>, `${p}[${i}]`, depth + 1); if (r) return r; }
        }
      } else if (v !== null && typeof v === "object") {
        const r = walk(v as Record<string, unknown>, p, depth + 1); if (r) return r;
      } else if (v !== null && typeof v !== "boolean" && v !== undefined) {
        return { ok: false, reason: "forbidden_metadata", detail: `${p}: unsupported value type ${typeof v}` };
      }
    }
    return null;
  };
  const bad = walk(meta as Record<string, unknown>, "", 1);
  return bad ?? { ok: true, value: JSON.parse(JSON.stringify(meta)) as Record<string, unknown> };
}
