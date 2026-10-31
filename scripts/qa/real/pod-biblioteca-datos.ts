/**
 * USD 0, SOLO LECTURA: valida la lógica de la biblioteca de Podcast (PR #254) con los DATOS REALES de la cuenta dueña,
 * sin navegador y sin escribir. Ejecuta el library.ts EXACTO del SHA indicado sobre las mismas consultas que la página
 * (tope 100 por fuente, por updated_at). Imprime solo conteos y comprobaciones: ningún título, id ni correo.
 */
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const OWNER_EMAIL_SHA256 = "8dcc0bfc5e69efb6c156c7972579693e10c2ff3c72ca363fc6d1fb79d58fdaac"; // mismo criterio que session.mjs
type Row = { id: string; user_id: string; title: string | null; status: string; created_at: string; updated_at: string | null; video_status?: string | null; archived_at?: string | null };

async function main() {
  const lib = await import(process.env.LIBRARY_TS!);
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  let owner = "";
  for (let page = 1; page <= 50 && !owner; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error("no se pudieron listar cuentas");
    owner = data.users.find((u) => u.email && createHash("sha256").update(u.email.trim().toLowerCase()).digest("hex") === OWNER_EMAIL_SHA256)?.id ?? "";
    if (data.users.length < 200) break;
  }
  if (!owner) throw new Error("cuenta dueña no encontrada");
  let fails = 0;
  const ok = (name: string, cond: boolean, detail?: unknown) => { if (!cond) fails++; console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond || detail === undefined ? "" : "  " + JSON.stringify(detail)}`); };

  const read = async (table: string, cols: string) => {
    const q = (c: string) => db.from(table).select(c).eq("user_id", owner).order("updated_at", { ascending: false }).limit(100);
    let r = await q(`${cols},archived_at`); const column = !r.error;
    if (!column) r = await q(cols);
    if (r.error) throw new Error(`lectura ${table}: ${r.error.message}`);
    return { rows: (r.data ?? []) as unknown as Row[], column };
  };
  const total = async (table: string) => (await db.from(table).select("id", { count: "exact", head: true }).eq("user_id", owner)).count ?? -1;
  const st = await read("podcast_studio_episodes", "id,user_id,title,status,created_at,updated_at");
  const v2 = await read("podcast_episodes", "id,user_id,title,status,video_status,created_at,updated_at");
  const all = [...st.rows.map((r) => ({ ...r, kind: "studio" as const })), ...v2.rows.map((r) => ({ ...r, kind: "v2" as const }))];
  const now = Date.now();
  const main = lib.libraryView(all, "principal", now), arch = lib.libraryView(all, "archivados", now);
  const buckets: Record<string, number> = {};
  for (const x of [...main, ...arch]) buckets[x.bucket] = (buckets[x.bucket] ?? 0) + 1;
  console.log(`DATOS estudio=${st.rows.length}/${await total("podcast_studio_episodes")} clasico=${v2.rows.length}/${await total("podcast_episodes")} (mostrados/total de la cuenta) columna_archived_at=${st.column && v2.column}`);
  console.log(`VISTAS principal=${main.length} archivados=${arch.length} grupos=${JSON.stringify(buckets)}`);

  ok("todas las filas leídas son de la cuenta dueña (filtro user_id)", all.every((r) => r.user_id === owner));
  ok("nada se pierde: cada episodio está en una de las dos vistas", main.length + arch.length === all.length && new Set([...main, ...arch].map((x) => `${x.kind}:${x.id}`)).size === all.length);
  ok("lo que está en producción nunca se oculta", arch.every((x) => x.bucket !== "en_curso"));
  ok("«Mis episodios» no contiene errores, pruebas ni borradores viejos", main.every((x) => !["fallido", "prueba", "antiguo", "archivado"].includes(x.bucket)));
  const rank: Record<string, number> = { en_curso: 0, listo: 1, borrador: 2 };
  ok("orden global: en curso → terminados → borradores recientes", main.every((x, i) => i === 0 || rank[main[i - 1].bucket] <= rank[x.bucket]));
  const act = (x: Row) => Date.parse(x.updated_at || x.created_at);
  ok("dentro de cada grupo, actividad más reciente primero", main.every((x, i) => i === 0 || main[i - 1].bucket !== x.bucket || act(main[i - 1]) >= act(x)));
  const classicEdited = v2.rows.filter((r) => r.updated_at && Date.parse(r.updated_at) - Date.parse(r.created_at) > 86_400_000).length;
  console.log(`INFO clásicos editados ≥1 día después de crearse: ${classicEdited} (su antigüedad se mide por updated_at)`);
  const tests = all.filter((r) => lib.isTestTitle(r.title)).length;
  console.log(`INFO títulos de prueba según la regla: ${tests}`);
  if (!(st.column && v2.column)) console.log("INFO sin columna archived_at: archivar/restaurar a mano no disponible (aviso en la página); la agrupación automática no escribe nada");
  console.log(`RESULT pod-biblioteca-datos: ${fails === 0 ? "OK" : "FALLA"} fail=${fails}`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.log("FAIL", String(e?.message ?? e)); process.exit(1); });
