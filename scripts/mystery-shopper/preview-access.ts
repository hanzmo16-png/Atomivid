/** An SSO redirect can finish with HTTP 200. Never submit QA credentials outside the pinned Preview. */
export function previewAccessBlocked(expected: string, observed: string, status: number | null): boolean {
  try { return new URL(expected).origin !== new URL(observed).origin || status === 401 || status === 403; }
  catch { return true; }
}
/** Existing automation credentials are sent only to the exact authorized origin. */
export function previewProtectionHeaders(expected: string, observed: string, secret: string | undefined): Record<string,string> {
  if (!secret) return {};
  try {
    if (new URL(expected).origin !== new URL(observed).origin) return {};
    return { "x-vercel-protection-bypass": secret, "x-vercel-set-bypass-cookie": "true" };
  } catch { return {}; }
}
