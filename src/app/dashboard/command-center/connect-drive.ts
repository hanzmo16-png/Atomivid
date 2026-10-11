/**
 * Owner action «Conectar Google Drive» (orchestrator channel). Same pattern as «Conectar YouTube»: the browser asks
 * the server to START the flow and follows the consent URL only if it is Google's OAuth endpoint. State, PKCE and the
 * token stay server side (/api/orchestrator/drive/*); nothing sensitive is received, built or stored here.
 */
import { isGoogleConsentUrl, safeMessage } from "./connect-youtube";

export const DRIVE_CONNECT_ENDPOINT = "/api/orchestrator/drive/connect";
type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; credentials: "same-origin" }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function startDriveConnect(deps: { fetchImpl: FetchLike; navigate: (url: string) => void }): Promise<{ ok: true } | { ok: false; message: string }> {
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await deps.fetchImpl(DRIVE_CONNECT_ENDPOINT, { method: "POST", headers: { accept: "application/json" }, credentials: "same-origin" });
  } catch { return { ok: false, message: "No se pudo iniciar la conexión (sin respuesta del servidor)." }; }
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) return { ok: false, message: safeMessage(res.status, body) };
  const url = (body as { url?: unknown } | null)?.url;
  if (!isGoogleConsentUrl(url)) return { ok: false, message: "Respuesta inesperada del servidor: no se abrió ninguna página externa." };
  deps.navigate(url);
  return { ok: true };
}

/** The callback's short result code (?drive=...) → one plain sentence. Unknown codes never echo the input. */
export function driveResultMessage(code: string | undefined): { tone: "ok" | "error"; text: string } | null {
  if (!code) return null;
  const known: Record<string, string> = {
    conectado: "Google Drive conectado. El orquestador ya puede leer y escribir en la carpeta de coordinación.",
    denied: "Se canceló el consentimiento en Google. No se guardó nada.",
    expired: "El intento caducó (15 minutos) o empezó en otro navegador. Pulsa el botón otra vez.",
    state: "La respuesta de Google no corresponde a este intento. Pulsa el botón otra vez.",
    exchange: "Google no entregó un permiso válido de Drive completo. Pulsa el botón otra vez y marca la casilla de Drive.",
    check: "La cuenta elegida no es la dueña de la carpeta de coordinación. Usa la cuenta de trabajo dueña de esa carpeta.",
    config: "Falta configuración del cliente OAuth en el servidor (ver docs/ORCHESTRATOR.md).",
    "sin-permiso": "Solo el propietario puede conectar Google Drive.",
  };
  return code in known ? { tone: code === "conectado" ? "ok" : "error", text: known[code] } : { tone: "error", text: "No se pudo completar la conexión. No se guardó nada." };
}
