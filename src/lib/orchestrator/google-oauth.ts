/**
 * One-time Google authorization for the orchestrator from GitHub Actions, usable from a phone (pure helpers; I/O in
 * scripts/orchestrator/google-oauth-actions.ts). Why this shape (official Google docs, checked 2026-10-10):
 *  - the device flow does not allow the `drive` scope (only drive.file / drive.appdata, which cannot see files that
 *    ChatGPT's or Claude's connectors create), so it cannot be used;
 *  - service accounts / Workload Identity Federation cannot act as a personal Gmail user and cannot own files;
 *  - a "Desktop app" client keeps the loopback redirect. On the phone the browser lands on an unreachable
 *    http://127.0.0.1 page whose address carries a single-use code; the owner copies that address into the
 *    "finish" run. The code alone is useless: the exchange also needs the client secret (repository secret) and the
 *    PKCE verifier, derived here from the client secret and the public nonce of the "start" run (nothing is stored).
 *  - the refresh token goes straight into a repository secret (`gh secret set`, value on stdin); it is never printed.
 *  - the consent screen must be "In production" (unverified is fine for personal use): in "Testing" Google issues
 *    refresh tokens that expire after 7 days.
 */
import { createHash, createHmac } from "node:crypto";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
export const LOOPBACK_REDIRECT = "http://127.0.0.1:8765/callback";
export const NONCE_RE = /^[0-9a-f]{32}$/;

/** PKCE verifier bound to the client secret and the start run's nonce (43+ chars of base64url, RFC 7636). */
export const pkceVerifier = (clientSecret: string, nonce: string) => createHmac("sha256", clientSecret).update(`atomivid-orch-oauth:${nonce}`).digest("base64url") + "Pkce";
export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

export function consentUrl(clientId: string, clientSecret: string, nonce: string): string {
  if (!NONCE_RE.test(nonce)) throw new Error("nonce inválido");
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.search = new URLSearchParams({
    client_id: clientId, redirect_uri: LOOPBACK_REDIRECT, response_type: "code", scope: DRIVE_SCOPE,
    access_type: "offline", prompt: "consent", state: nonce, code_challenge: pkceChallenge(pkceVerifier(clientSecret, nonce)), code_challenge_method: "S256",
  }).toString();
  return u.toString();
}

export type ParsedRedirect = { ok: true; code: string; nonce: string } | { ok: false; reason: string };

/** Parses the address the browser landed on (http://127.0.0.1:8765/callback?state=…&code=…). */
export function parseRedirect(raw: string): ParsedRedirect {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, reason: "la dirección pegada no es una URL" }; }
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return { ok: false, reason: "la dirección no es la de retorno local (127.0.0.1)" };
  const err = u.searchParams.get("error");
  if (err) return { ok: false, reason: `Google devolvió «${err.slice(0, 40)}» (¿se canceló el consentimiento?)` };
  const code = u.searchParams.get("code") ?? "", nonce = u.searchParams.get("state") ?? "";
  if (!NONCE_RE.test(nonce)) return { ok: false, reason: "falta el estado de la ejecución «start» o no es válido" };
  if (!/^[A-Za-z0-9/_.-]{10,512}$/.test(code)) return { ok: false, reason: "falta el código de autorización o no es válido" };
  return { ok: true, code, nonce };
}

export function tokenRequestBody(input: { code: string; nonce: string; clientId: string; clientSecret: string }): string {
  return new URLSearchParams({
    code: input.code, client_id: input.clientId, client_secret: input.clientSecret, redirect_uri: LOOPBACK_REDIRECT,
    grant_type: "authorization_code", code_verifier: pkceVerifier(input.clientSecret, input.nonce),
  }).toString();
}

export type TokenCheck = { ok: true; refreshToken: string } | { ok: false; reason: string };

/** The exchange must return a refresh token with the full drive scope. */
export function checkTokenResponse(status: number, body: { refresh_token?: string; scope?: string; error?: string } | null): TokenCheck {
  if (status !== 200 || !body) return { ok: false, reason: `Google rechazó el canje (${body?.error?.slice(0, 40) ?? status}); el código dura minutos y sirve una sola vez: repite «start»` };
  if (!body.refresh_token) return { ok: false, reason: "Google no entregó un token de renovación (repite «start»: el consentimiento pide acceso sin conexión)" };
  if (!(body.scope ?? "").split(" ").includes(DRIVE_SCOPE)) return { ok: false, reason: "el permiso concedido no incluye Google Drive completo (marca la casilla de Drive en el consentimiento)" };
  return { ok: true, refreshToken: body.refresh_token };
}
