import type { SupabaseClient } from "@supabase/supabase-js";
import { EDITOR_BUCKET, parseVersionSegment, validEpisodeId } from "./contract";
import type { EditorStorage } from "./verify";

const MAX_MARKER_BYTES = 256 * 1024;
/** Signed URLs handed to the owner's browser: short-lived, per object. */
export const PLAYBACK_URL_TTL_SECONDS = 15 * 60;

type Item = { name: string; id: string | null; created_at?: string | null; metadata?: { size?: number } | null };

/**
 * Storage port bound to the signed-in OWNER's session client (cookies), never the service role: the approved
 * policy pe_v2_propietario_leer is what grants the read, so an account that is not enrolled in
 * podcast_editor.propietarios gets empty listings and failed downloads.
 */
export function ownerEditorStorage(supabase: SupabaseClient): EditorStorage & {
  listVersions(): Promise<{ episodeId: string; version: number }[]>;
  signedUrl(path: string, download?: string): Promise<string>;
} {
  const bucket = () => supabase.storage.from(EDITOR_BUCKET);
  const listRaw = async (folder: string): Promise<Item[]> => {
    const { data, error } = await bucket().list(folder, { limit: 1000, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error("No se pudo leer el área del editor.");
    return (data ?? []) as Item[];
  };
  const signedUrl = async (path: string, download?: string) => {
    const { data, error } = await bucket().createSignedUrl(path, PLAYBACK_URL_TTL_SECONDS, download ? { download } : undefined);
    if (error || !data?.signedUrl) throw new Error("No se pudo firmar el acceso al archivo.");
    return data.signedUrl;
  };
  return {
    async list(folder) {
      return (await listRaw(folder)).filter((i) => i.id !== null).map((i) => ({ name: i.name, bytes: typeof i.metadata?.size === "number" ? i.metadata.size : null, createdAt: i.created_at ?? null }));
    },
    async readText(path) {
      const folder = path.slice(0, path.lastIndexOf("/"));
      const name = path.slice(path.lastIndexOf("/") + 1);
      const entry = (await listRaw(folder)).find((i) => i.name === name);
      if (!entry || (entry.metadata?.size ?? 0) > MAX_MARKER_BYTES) throw new Error("COMPLETO.json ausente o demasiado grande.");
      const { data, error } = await bucket().download(path);
      if (error || !data) throw new Error("No se pudo leer COMPLETO.json.");
      return await data.text();
    },
    async stream(path) {
      const res = await fetch(await signedUrl(path), { cache: "no-store" });
      if (!res.ok || !res.body) throw new Error("No se pudo descargar la salida para verificarla.");
      return res.body;
    },
    async listVersions() {
      const out: { episodeId: string; version: number }[] = [];
      for (const ep of await listRaw("episodios")) {
        if (ep.id !== null || !validEpisodeId(ep.name)) continue;
        for (const v of await listRaw(`episodios/${ep.name}`)) {
          const version = v.id === null ? parseVersionSegment(v.name) : null;
          if (version) out.push({ episodeId: ep.name, version });
        }
      }
      return out;
    },
    signedUrl,
  };
}
