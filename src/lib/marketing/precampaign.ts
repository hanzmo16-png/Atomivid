/**
 * Precampaign interest page (/lanzamiento). Pure helpers shared by the page and its tests.
 * The page records interest in the same "reels" launch list as /avisame (no new table or product), never
 * charges, and promises no price, date or number of places: those are not decided yet.
 */

/** Demo video shown on the page only when an owner-approved public URL is configured (https only). */
export function precampaignDemoUrl(env: Record<string, string | undefined>): string | null {
  const raw = env.NEXT_PUBLIC_PRECAMPAIGN_DEMO_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Claims the page must never make while the offer is undecided (checked by the tests on the page source). */
export const FORBIDDEN_PRECAMPAIGN_CLAIMS = [/\$\s?\d/, /USD/i, /MXN/i, /cupos?\b/i, /últimos lugares/i, /gratis/i, /garantiza/i, /instant[aá]ne/i, /sin errores/i];
