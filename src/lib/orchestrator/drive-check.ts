/**
 * Real-connection check of the Drive authorisation, without any GitHub writer token (mode "verify" of
 * drive-oauth.yml): refreshes the stored refresh token, requires the full drive scope, requires the account to OWN
 * the coordination folder and be able to write in it, and the Solicitudes/Entregas folders to be inside it. Reports
 * booleans and counts only (no token, no file name, no content). `fetchImpl` is injectable (FakeDrive in tests).
 */
import { DriveRestChannel } from "./channel";
import { DRIVE_SCOPE } from "./google-oauth";

export type DriveTarget = { root: string; solicitudes: string; entregas: string };
export type DriveCheckResult = {
  ok: boolean;
  checks: { tokenRefreshes: boolean; fullDriveScope: boolean; ownsCoordinationFolder: boolean; canWriteThere: boolean; subfoldersInside: boolean };
  counts: { solicitudes: number; entregas: number } | null;
  reason: string | null;
};
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function checkDriveConnection(creds: { clientId: string; clientSecret: string; refreshToken: string }, target: DriveTarget, fetchImpl: FetchLike = fetch): Promise<DriveCheckResult> {
  const checks = { tokenRefreshes: false, fullDriveScope: false, ownsCoordinationFolder: false, canWriteThere: false, subfoldersInside: false };
  const done = (reason: string | null, counts: DriveCheckResult["counts"] = null): DriveCheckResult => ({ ok: reason === null && Object.values(checks).every(Boolean), checks, counts, reason });
  const tok = await fetchImpl("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: creds.refreshToken, client_id: creds.clientId, client_secret: creds.clientSecret }).toString() }).catch(() => null);
  const body = tok && tok.ok ? ((await tok.json().catch(() => null)) as { access_token?: string; scope?: string } | null) : null;
  if (!body?.access_token) return done("el token de renovación no funciona (revocado, de otro cliente o con la app en «Prueba» y caducado): repite la autorización");
  checks.tokenRefreshes = true;
  checks.fullDriveScope = (body.scope ?? "").split(" ").includes(DRIVE_SCOPE);
  if (!checks.fullDriveScope) return done("el permiso concedido no es Google Drive completo");
  const headers = { authorization: `Bearer ${body.access_token}` };
  const meta = async (id: string) => {
    const r = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?fields=id,mimeType,parents,ownedByMe,capabilities(canAddChildren)`, { headers }).catch(() => null);
    return r && r.ok ? ((await r.json().catch(() => null)) as { parents?: string[]; ownedByMe?: boolean; capabilities?: { canAddChildren?: boolean } } | null) : null;
  };
  const root = await meta(target.root);
  checks.ownsCoordinationFolder = root?.ownedByMe === true;
  checks.canWriteThere = root?.capabilities?.canAddChildren === true;
  if (!checks.ownsCoordinationFolder) return done("la cuenta autorizada no es la dueña de la carpeta de coordinación (usa la cuenta de trabajo dueña de esa carpeta)");
  if (!checks.canWriteThere) return done("la cuenta no puede escribir en la carpeta de coordinación");
  const [s, e] = await Promise.all([meta(target.solicitudes), meta(target.entregas)]);
  checks.subfoldersInside = !!s?.parents?.includes(target.root) && !!e?.parents?.includes(target.root);
  if (!checks.subfoldersInside) return done("Solicitudes/Entregas no están dentro de la carpeta de coordinación");
  const channel = new DriveRestChannel({ solicitudes: target.solicitudes, entregas: target.entregas }, async () => body.access_token!, fetchImpl);
  const [ls, le] = await Promise.all([channel.list("solicitudes"), channel.list("entregas")]);
  return done(null, { solicitudes: ls.length, entregas: le.length });
}
