/**
 * Incidente Mystery Shopper (producción, 26-11): «Guardar» mostró «Guardado», pero al recargar el guion estaba vacío.
 * El JSON del proyecto se sobrescribe en el mismo objeto de Storage; el CDN de Supabase puede seguir sirviendo la copia
 * anterior unos segundos tras la sobrescritura. Cada lectura del proyecto debe pedir el objeto con un `cacheNonce`
 * único (opción oficial de storage-js para saltarse la caché) para leer siempre lo último guardado.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProject, getProject, saveProject } from "./service";
import { storageStore } from "./store";

const A = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-11-26T15:15:00.000Z";
let n = 0;
const ids = () => `aaaaaaaa-0000-4000-8000-${String(++n).padStart(12, "0")}`;

/** Bucket con caché de CDN: sin nonce sirve la primera copia descargada de cada ruta, aunque se sobrescriba. */
function cdnBucket() {
  const objects = new Map<string, string>();
  const cdn = new Map<string, string>();
  const nonces: string[] = [];
  return {
    nonces,
    async list(prefix: string) { return { data: [...objects.keys()].filter((k) => k.startsWith(prefix + "/")).map((k) => ({ name: k.slice(prefix.length + 1) })), error: null }; },
    async download(p: string, opts?: { cacheNonce?: string | number }) {
      const fresh = objects.get(p);
      if (fresh === undefined) return { data: null, error: { message: "Object not found", statusCode: "404" } };
      if (opts?.cacheNonce != null) { nonces.push(String(opts.cacheNonce)); return { data: new Blob([fresh]), error: null }; }
      if (!cdn.has(p)) cdn.set(p, fresh);
      return { data: new Blob([cdn.get(p)!]), error: null };
    },
    async upload(p: string, body: string | Blob, o: { upsert: boolean }) {
      if (!o.upsert && objects.has(p)) return { error: { message: "The resource already exists", statusCode: "409" } };
      objects.set(p, typeof body === "string" ? body : await body.text()); return { error: null };
    },
  };
}

test("guardar y recargar: el guion recién guardado se lee aunque el CDN tenga la copia anterior", async () => {
  const bucket = cdnBucket();
  const d = { store: storageStore(bucket), now: () => NOW, newId: ids, env: {} };
  const c = await createProject(d, A, { title: "QA cliente misterioso" });
  const id = (c.body as { id: string }).id;
  const abierto = await getProject(d, A, id); // abrir el editor: la copia vacía entra en la caché
  const revision = (abierto.body as { revision: number }).revision;
  const guion = "Ana: Hola, esto es una prueba del cliente misterioso de ATOMIVID.";
  const s = await saveProject(d, A, id, { revision, script: guion });
  assert.equal(s.status, 200);
  const recargado = await getProject(d, A, id);
  assert.equal((recargado.body as { script: string }).script, guion);
  // Y el siguiente guardado no choca con una revisión vieja servida por la caché.
  const s2 = await saveProject(d, A, id, { revision: (recargado.body as { revision: number }).revision, script: guion + " Fin." });
  assert.equal(s2.status, 200);
  assert.ok(bucket.nonces.length >= 3 && new Set(bucket.nonces).size === bucket.nonces.length, "cada lectura usa un nonce distinto");
});
