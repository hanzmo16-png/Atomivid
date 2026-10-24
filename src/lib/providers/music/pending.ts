/**
 * Pistas PENDIENTES de ingesta (content/music/pending-epic-tracks.json). El catálogo las publica solo cuando su objeto
 * ya está en el bucket privado `music-library` con el tamaño exacto fijado en la validación previa; al descargarse,
 * el sha256 debe coincidir (real.ts). Antes de una ingesta exitosa nunca se eligen, así que una pista inexistente o
 * distinta no puede entrar en una mezcla. Solo instrumentales (condición obligatoria del banco).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import pending from "../../../../content/music/pending-epic-tracks.json";
import type { MusicTone } from "../types";
import type { MusicTrackEntry } from "./manifest";
import { MUSIC_LIBRARY_BUCKET } from "./storage";

type PendingTrack = { id: string; title: string; author: string; sourceUrl: string; license: string; attribution: string; provider: string;
  instrumental: boolean; tones: string[]; storagePath: string; sha256: string; bytes: number; excludedReason?: string };

export const PENDING_MUSIC_TRACKS: MusicTrackEntry[] = (pending.tracks as PendingTrack[])
  .filter((t) => t.instrumental === true && !t.excludedReason)
  .map((t) => ({ id: t.id, title: t.title, author: t.author, sourceUrl: t.sourceUrl, license: t.license, provider: t.provider,
    dateObtainedISO: "2026-10-23", instrumental: true as const, tones: t.tones as MusicTone[], styleTags: [], storagePath: t.storagePath,
    attribution: t.attribution, sha256: t.sha256, bytes: t.bytes }));

type ListedObject = { name: string; metadata?: { size?: number } | null };
/** Pending tracks whose object is in the bucket with the pinned size. A listing error publishes nothing. */
export async function publishedPendingTracks(service: Pick<SupabaseClient, "storage">, tracks: MusicTrackEntry[] = PENDING_MUSIC_TRACKS): Promise<MusicTrackEntry[]> {
  if (!tracks.length) return [];
  const { data, error } = await service.storage.from(MUSIC_LIBRARY_BUCKET).list("", { limit: 1000 });
  if (error || !Array.isArray(data)) return [];
  const sizes = new Map((data as ListedObject[]).map((o) => [o.name, Number(o.metadata?.size)]));
  return tracks.filter((t) => sizes.get(t.storagePath) === t.bytes);
}
