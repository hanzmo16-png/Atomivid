/**
 * Shared, content-addressed storage of stock clips (cost follow-up to chatgpt-07).
 * A Pexels video/photo with the same id AND the same delivered resolution is the same file, so it is stored
 * once under `stock/<sourceId>-<w>x<h>.<ext>` and every later Reel reuses that object instead of downloading
 * and uploading it again into its own attempt folder.
 *
 * Idempotent and fail-safe:
 *   - only stable provider ids qualify (`pexels-video-<n>` / `pexels-photo-<n>`) with a known width × height;
 *     fixtures and URL-derived ids never do (they are not stable content keys);
 *   - lookup error → `{ kind: "lookup_failed" }`: the caller uploads exactly as before (per-request path);
 *   - not found → the caller downloads and uploads ONCE to the shared path (upsert of identical bytes is safe
 *     if two jobs race).
 * Nothing here deletes anything.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const STOCK_PREFIX = "stock";
const STABLE_ID = /^pexels-(video|photo)-\d{1,15}$/;
const EXTENSION = /^[a-z0-9]{2,5}$/;

export function sharedStockPath(sourceId: string | undefined, media: { extension: string; width?: number; height?: number }): string | null {
  if (!sourceId || !STABLE_ID.test(sourceId)) return null;
  const { width, height } = media;
  if (!Number.isInteger(width) || !Number.isInteger(height) || (width as number) <= 0 || (height as number) <= 0) return null;
  const ext = media.extension.toLowerCase();
  if (!EXTENSION.test(ext)) return null;
  return `${STOCK_PREFIX}/${sourceId}-${width}x${height}.${ext}`;
}

export type StockLookup = { kind: "found" } | { kind: "missing" } | { kind: "lookup_failed"; reason: string };

/** Exact-name lookup inside `stock/` (a `list` with `search`, then an exact name and non-empty size check). */
export async function lookupSharedStock(supabase: Pick<SupabaseClient, "storage">, bucket: string, objectPath: string): Promise<StockLookup> {
  const slash = objectPath.lastIndexOf("/");
  const folder = objectPath.slice(0, slash), name = objectPath.slice(slash + 1);
  try {
    const { data, error } = await supabase.storage.from(bucket).list(folder, { search: name, limit: 10 });
    if (error) return { kind: "lookup_failed", reason: error.message };
    const hit = (data ?? []).find((f: { name: string; metadata?: { size?: number } | null }) => f.name === name);
    if (!hit) return { kind: "missing" };
    const size = Number(hit.metadata?.size ?? 0);
    return size > 0 ? { kind: "found" } : { kind: "missing" };
  } catch (err) {
    return { kind: "lookup_failed", reason: err instanceof Error ? err.message : String(err) };
  }
}

export type StockPlacement =
  | { reuse: true; path: string }
  | { reuse: false; path: string; shared: boolean; lookup: StockLookup["kind"] | "not_eligible" };

/** Decides where this clip lives: reuse the shared object, upload once to it, or (ineligible / lookup failed) upload as before. */
export async function placeStockClip(
  supabase: Pick<SupabaseClient, "storage">,
  bucket: string,
  a: { sourceId?: string; media: { extension: string; width?: number; height?: number }; perRequestPath: string },
): Promise<StockPlacement> {
  const shared = sharedStockPath(a.sourceId, a.media);
  if (!shared) return { reuse: false, path: a.perRequestPath, shared: false, lookup: "not_eligible" };
  const found = await lookupSharedStock(supabase, bucket, shared);
  if (found.kind === "found") return { reuse: true, path: shared };
  if (found.kind === "missing") return { reuse: false, path: shared, shared: true, lookup: "missing" };
  return { reuse: false, path: a.perRequestPath, shared: false, lookup: "lookup_failed" };
}
