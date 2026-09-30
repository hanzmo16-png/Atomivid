/**
 * Owner action "Conectar YouTube (solo lectura)": the browser only asks the server to START the
 * read-only OAuth flow and follows the consent URL the server built. Scopes, PKCE, state and
 * tokens live server side (see /api/distribution/youtube/connect); nothing sensitive is received,
 * built or stored here. The consent URL is followed only when it is Google's OAuth endpoint.
 */
export const CONNECT_ENDPOINT = "/api/distribution/youtube/connect";
const GOOGLE_CONSENT_ORIGIN = "https://accounts.google.com";
const GOOGLE_CONSENT_PATH = "/o/oauth2/v2/auth";

export type ConnectStart = { ok: true; url: string; connectionId: string } | { ok: false; message: string };
type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; credentials: "same-origin" }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Only a short, plain server message is shown; anything that looks like a trace or a blob is replaced. */
export function safeMessage(status: number, body: unknown): string {
  const raw = body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : "";
  const plain = raw.trim();
  const looksSensitive = plain.length === 0 || plain.length > 160 || /\n|\s at |stack|token|secret|key=|https?:\/\//i.test(plain);
  return looksSensitive ? `No se pudo iniciar la conexión (HTTP ${status}).` : `No se pudo iniciar la conexión (HTTP ${status}): ${plain}`;
}

export function isGoogleConsentUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try { const u = new URL(url); return u.origin === GOOGLE_CONSENT_ORIGIN && u.pathname === GOOGLE_CONSENT_PATH; } catch { return false; }
}

export async function startYouTubeConnect(deps: { fetchImpl: FetchLike; navigate: (url: string) => void }): Promise<ConnectStart> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await deps.fetchImpl(CONNECT_ENDPOINT, { method: "POST", headers: { accept: "application/json" }, credentials: "same-origin" });
  } catch { return { ok: false, message: "No se pudo iniciar la conexión (sin respuesta del servidor)." }; }
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) return { ok: false, message: safeMessage(res.status, body) };
  const url = (body as { url?: unknown } | null)?.url, connectionId = (body as { connectionId?: unknown } | null)?.connectionId;
  if (!isGoogleConsentUrl(url) || typeof connectionId !== "string") return { ok: false, message: "Respuesta inesperada del servidor: no se abrió ninguna página externa." };
  deps.navigate(url);
  return { ok: true, url, connectionId };
}
