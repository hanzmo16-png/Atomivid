/**
 * Safe check of the owner's GitHub notifications on Android (pure, no I/O; run by scripts/notice-check.ts).
 * Emission and reception are separate facts:
 *  - emission: the Actions bot posts ONE generic test comment on the notices issue, mentioning the owner (a comment
 *    written with the owner's own token never notifies them);
 *  - reception: only the owner can confirm it, by reacting 👍 to that comment from the notification on the phone.
 *    The verify step reads that reaction (login = owner) and reports when it happened; nothing else counts.
 * The comment carries no link, id, data or credential (the repository is public), and sends are rate limited.
 */
export const TEST_MARKER = "Prueba de aviso de Atomivid";
export const NOTICE_ISSUE_TITLE = "Avisos de producción de Atomivid";

/**
 * The notices issue: the title AND an author that can be trusted (the owner or the Actions bot). Anyone can open an
 * issue with the same title in a public repository; the bot must never post the owner's notices there.
 */
export const isNoticeIssue = (i: { title?: string; user?: { login?: string } | null; pull_request?: unknown }, owner: string) =>
  i.title === NOTICE_ISSUE_TITLE && !i.pull_request && (i.user?.login?.toLowerCase() === owner.toLowerCase() || i.user?.login === "github-actions[bot]");
export const MIN_GAP_MS = 10 * 60_000;

export const testCode = (now: Date) => `NC-${now.toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;

export function testComment(mention: string, code: string): string {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(mention)) throw new Error("usuario a mencionar inválido");
  if (!/^NC-\d{12}$/.test(code)) throw new Error("código inválido");
  return `@${mention} ${TEST_MARKER} ${code}. Si este aviso te llegó al teléfono, reacciona con 👍 a este comentario. No hace falta nada más.`;
}

export type BotComment = { id: number; body: string; created_at: string; user: { login: string } | null };
export const isTestComment = (c: BotComment) => c.user?.login === "github-actions[bot]" && c.body.includes(TEST_MARKER);

/** The newest test comment posted by the bot, if any. */
export const latestTest = (comments: BotComment[]) => comments.filter(isTestComment).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;

export function sendDecision(comments: BotComment[], now: Date): { ok: true } | { ok: false; reason: string } {
  const last = latestTest(comments);
  if (last && now.getTime() - Date.parse(last.created_at) < MIN_GAP_MS) return { ok: false, reason: "ya se envió una prueba hace menos de 10 minutos" };
  return { ok: true };
}

export type Reaction = { content: string; created_at: string; user: { login: string } | null };
export type Reception = { emitted: true; received: boolean; reactedAt: string | null; secondsAfterEmission: number | null };

/** Reception = a 👍 by the owner on that comment; reactions by anyone else are ignored. */
export function reception(comment: BotComment, reactions: Reaction[], owner: string): Reception {
  const own = reactions.filter((r) => r.content === "+1" && r.user?.login?.toLowerCase() === owner.toLowerCase()).sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
  if (!own) return { emitted: true, received: false, reactedAt: null, secondsAfterEmission: null };
  return { emitted: true, received: true, reactedAt: own.created_at, secondsAfterEmission: Math.max(0, Math.round((Date.parse(own.created_at) - Date.parse(comment.created_at)) / 1000)) };
}
