import { createHash } from "node:crypto";
import { COMPLETE_MARKER, outputFolder, parseCompleteManifest, primaryMedia, versionFolder, type DeclaredOutput } from "./contract";

/**
 * Minimal view of Storage used here, always bound to the OWNER's own session (never service role): the
 * approved policies let only an enrolled owner (podcast_editor.propietarios) read the whole bucket, so a
 * non-owner simply sees nothing. Injected so tests run without a network.
 */
export type EditorStorage = {
  /** Files directly inside a folder: name, size in bytes and creation time (ISO). Folders are omitted. */
  list(folder: string): Promise<{ name: string; bytes: number | null; createdAt: string | null }[]>;
  /** Small text object (COMPLETO.json). */
  readText(path: string): Promise<string>;
  /** Streams an object's bytes (for sha256), without holding the whole file in memory. */
  stream(path: string): Promise<ReadableStream<Uint8Array>>;
};

export type DeliveryStatus =
  | { state: "sin_entrega" }                                           // no COMPLETO.json yet (editor still working)
  | { state: "entrega_invalida"; reason: string }                      // COMPLETO.json present but fails the contract
  | { state: "pendiente_verificar"; objetos: DeclaredOutput[] }        // structure and sizes match; hashes not checked
  | { state: "terminado"; objetos: DeclaredOutput[]; primary: DeclaredOutput | null }; // every hash verified

/**
 * Reads salida/COMPLETO.json and checks it against the actual objects of that episode/version:
 *  - every declared object (salida/, salida/muestras/, estado/reporte-*.json) exists with exactly the declared size;
 *  - COMPLETO.json was written last (editor contract: objects first, marker last);
 *  - with { hashes: true }, every object's sha256 is recomputed from Storage and must match.
 * Only the last case returns "terminado". Nothing is written anywhere.
 */
export async function checkDelivery(storage: EditorStorage, episodeId: string, version: number, opts: { hashes: boolean; deadline?: number } = { hashes: false }): Promise<DeliveryStatus> {
  const base = versionFolder(episodeId, version);
  const listings = new Map<string, Awaited<ReturnType<EditorStorage["list"]>>>();
  const listFolder = async (folder: string) => {
    if (!listings.has(folder)) listings.set(folder, await storage.list(folder));
    return listings.get(folder)!;
  };
  const marker = (await listFolder(outputFolder(episodeId, version))).find((f) => f.name === COMPLETE_MARKER);
  if (!marker) return { state: "sin_entrega" };

  const parsed = parseCompleteManifest(await storage.readText(`${outputFolder(episodeId, version)}/${COMPLETE_MARKER}`), { episodeId, version });
  if (!parsed.ok) return { state: "entrega_invalida", reason: parsed.reason };
  const { objetos } = parsed.manifest;

  for (const o of objetos) {
    const folder = `${base}/${o.key.slice(0, o.key.lastIndexOf("/"))}`;
    const name = o.key.slice(o.key.lastIndexOf("/") + 1);
    const f = (await listFolder(folder)).find((x) => x.name === name);
    if (!f) return { state: "entrega_invalida", reason: `falta el objeto ${o.key}` };
    if (f.bytes !== o.size) return { state: "entrega_invalida", reason: `tamaño distinto en ${o.key}` };
    if (marker.createdAt && f.createdAt && Date.parse(f.createdAt) > Date.parse(marker.createdAt)) {
      return { state: "entrega_invalida", reason: `${o.key} se subió después de COMPLETO.json` };
    }
  }
  if (!opts.hashes) return { state: "pendiente_verificar", objetos };

  for (const o of objetos) {
    const digest = await sha256Of(await storage.stream(`${base}/${o.key}`), o.size, opts.deadline);
    if (digest === "timeout") return { state: "pendiente_verificar", objetos };
    if (digest !== o.sha256) return { state: "entrega_invalida", reason: `sha256 distinto en ${o.key}` };
  }
  return { state: "terminado", objetos, primary: primaryMedia(objetos) };
}

/** sha256 of a stream; also enforces the declared length. "timeout" when the deadline passes first. */
async function sha256Of(body: ReadableStream<Uint8Array>, expectedBytes: number, deadline?: number): Promise<string | "timeout"> {
  const hash = createHash("sha256");
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      if (deadline && Date.now() > deadline) { await reader.cancel().catch(() => undefined); return "timeout"; }
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expectedBytes) { await reader.cancel().catch(() => undefined); return "length-mismatch"; }
      hash.update(value);
    }
  } finally {
    reader.releaseLock();
  }
  return total === expectedBytes ? hash.digest("hex") : "length-mismatch";
}
