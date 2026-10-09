import { createHash } from "node:crypto";
import { COMPLETE_MARKER, outputFolder, parseCompleteManifest, primaryMedia, type DeclaredOutput } from "./contract";

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
  | { state: "pendiente_verificar"; salidas: DeclaredOutput[] }        // structure and sizes match; hashes not checked
  | { state: "terminado"; salidas: DeclaredOutput[]; primary: DeclaredOutput | null }; // every hash verified

/**
 * Reads COMPLETO.json and checks it against the actual objects in salida/:
 *  - every declared output exists with exactly the declared size;
 *  - COMPLETO.json was written last (the editor's contract: outputs first, marker last);
 *  - with { hashes: true }, every output's sha256 is recomputed from Storage and must match.
 * Only the last case returns "terminado". Nothing is written anywhere.
 */
export async function checkDelivery(storage: EditorStorage, episodeId: string, version: number, opts: { hashes: boolean; deadline?: number } = { hashes: false }): Promise<DeliveryStatus> {
  const folder = outputFolder(episodeId, version);
  const files = await storage.list(folder);
  const marker = files.find((f) => f.name === COMPLETE_MARKER);
  if (!marker) return { state: "sin_entrega" };

  const parsed = parseCompleteManifest(await storage.readText(`${folder}/${COMPLETE_MARKER}`), { episodeId, version });
  if (!parsed.ok) return { state: "entrega_invalida", reason: parsed.reason };
  const { salidas } = parsed.manifest;

  const byName = new Map(files.map((f) => [f.name, f]));
  for (const s of salidas) {
    const f = byName.get(s.archivo);
    if (!f) return { state: "entrega_invalida", reason: `falta la salida ${s.archivo}` };
    if (f.bytes !== s.bytes) return { state: "entrega_invalida", reason: `tamaño distinto en ${s.archivo}` };
    if (marker.createdAt && f.createdAt && Date.parse(f.createdAt) > Date.parse(marker.createdAt)) {
      return { state: "entrega_invalida", reason: `${s.archivo} se subió después de COMPLETO.json` };
    }
  }
  if (!opts.hashes) return { state: "pendiente_verificar", salidas };

  for (const s of salidas) {
    const digest = await sha256Of(await storage.stream(`${folder}/${s.archivo}`), s.bytes, opts.deadline);
    if (digest === "timeout") return { state: "pendiente_verificar", salidas };
    if (digest !== s.sha256) return { state: "entrega_invalida", reason: `sha256 distinto en ${s.archivo}` };
  }
  return { state: "terminado", salidas, primary: primaryMedia(salidas) };
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
