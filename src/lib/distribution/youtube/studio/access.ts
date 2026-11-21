import { tokenForConnection } from "../connect-flow";
import type { YouTubeOAuthStore } from "../oauth-store";
import { StudioReadError } from "./read";

/** Only an explicit invalid_grant proves refresh consent is no longer usable.
 * Configuration, decryption, transport and malformed responses must not suggest
 * a new consent flow. No provider body or original error leaves the server. */
export async function studioAccessToken(
 deps: {store: YouTubeOAuthStore; env: Record<string, string | undefined>; fetch: typeof fetch}, connectionId: string,
): Promise<string> {
 try {
  const token = await tokenForConnection({...deps, fetch: async (input, init) => {
   const response = await deps.fetch(input, {...init, signal: AbortSignal.timeout(12_000)});
   if (!response.ok) {
    let revoked = false;
    try { const body = await response.json() as {error?: unknown}; revoked = response.status === 400 && body.error === "invalid_grant"; } catch {}
    throw new StudioReadError(revoked ? "reconnect" : "unavailable", revoked ? 409 : 503);
   }
   return response;
  }}, connectionId);
  if (typeof token !== "string" || !token.trim()) throw new StudioReadError("unavailable", 503);
  return token;
 } catch (error) {
  if (error instanceof StudioReadError) throw error;
  throw new StudioReadError("unavailable", 503);
 }
}
