/**
 * Server-side gate for Long Form. Default OFF.
 * Do not rely on hiding UI; every entrypoint must call assertLongFormAccess.
 * The P0 CLI is a separate owner-machine switch and does not enable the product.
 */

export class LongFormDisabledError extends Error {
  readonly code = "LONG_FORM_DISABLED";
  constructor() {
    super("Long Form is an internal beta and is disabled.");
    this.name = "LongFormDisabledError";
  }
}

export class LongFormNotAllowlistedError extends Error {
  readonly code = "LONG_FORM_NOT_ALLOWLISTED";
  constructor() {
    super("Long Form is enabled but this account is not allowlisted.");
    this.name = "LongFormNotAllowlistedError";
  }
}

function parseAllowlist(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

type EnvLike = Record<string, string | undefined>;

export function isLongFormEnabled(env: EnvLike = process.env): boolean {
  const raw = env.LONG_FORM_ENABLED?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function isLongFormAllowlisted(
  user: { id?: string | null; email?: string | null },
  env: EnvLike = process.env,
): boolean {
  const ids = parseAllowlist(env.LONG_FORM_ALLOWLIST_USER_IDS);
  const emails = parseAllowlist(env.LONG_FORM_ALLOWLIST_EMAILS);
  const id = user.id?.trim();
  const email = user.email?.trim().toLowerCase();
  if (id && ids.has(id.toLowerCase())) return true;
  if (email && emails.has(email)) return true;
  return false;
}

export function assertLongFormAccess(
  user: { id?: string | null; email?: string | null },
  env: EnvLike = process.env,
): void {
  if (!isLongFormEnabled(env)) throw new LongFormDisabledError();
  if (!isLongFormAllowlisted(user, env)) throw new LongFormNotAllowlistedError();
}

/** Owner machine only. Does not grant product access and does not check the allowlist. */
export function assertLongFormCliAllowed(env: EnvLike = process.env): void {
  if (env.LONG_FORM_P0_CLI === "1") return;
  throw new LongFormDisabledError();
}
