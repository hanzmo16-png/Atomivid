/**
 * Podcast — biblioteca limpia (T-20261030-1118). La lista mostraba al inicio pruebas, proyectos a medias y errores.
 * Nada se borra:
 *  - vista «Mis episodios»: una sola lista (estudio y clásico juntos): en curso primero, luego lo terminado y los
 *    borradores recientes, cada grupo por actividad más reciente (`updated_at`, o `created_at` si no hay);
 *  - vista «Archivados»: lo que el dueño archivó y, sin escribir nada, los episodios con error, los de prueba
 *    (regla `isTestTitle`) y los borradores de hace más de 7 días;
 *  - archivar/restaurar solo marca `archived_at` (columna de supabase/migrations/20261030170000_podcast_library_archive.sql);
 *    nunca toca archivos, enlaces, costos ni el libro de gastos. Lo que está en producción no se puede archivar.
 */
export type LibraryKind = "studio" | "v2";
export type LibraryItem = { kind: LibraryKind; id: string; status: string; created_at: string; updated_at?: string | null; archived_at?: string | null; video_status?: string | null; title?: string | null };
export type LibraryBucket = "en_curso" | "listo" | "borrador" | "archivado" | "fallido" | "prueba" | "antiguo";

/**
 * Episodio de prueba, regla determinista (solo el título; sin adivinar por palabras sueltas):
 *  - empieza por «QA », «Prueba real » o una etiqueta «[test]», «[prueba]», «[qa]» (sin distinguir mayúsculas), o
 *  - contiene una marca explícita «(ficticio)», «(ficticia)», «(simulado)» o «(simulada)».
 * Son los nombres que ponen las herramientas de QA en producción (scripts/qa/real) y los ensayos internos. Un título como «Prueba de sonido con mi
 * abuela» NO es prueba. Si un episodio real cayera aquí, sigue intacto y visible en «Archivados».
 */
const TEST_PREFIX = /^(qa |prueba real |\[(test|prueba|qa)\])/i;
const TEST_MARK = /\((ficticio|ficticia|simulado|simulada)\)/i;
export function isTestTitle(title: string | null | undefined): boolean {
  const t = (title ?? "").trim();
  return TEST_PREFIX.test(t) || TEST_MARK.test(t);
}

export const STALE_DAYS = 7;
const DAY = 86_400_000;

/** En producción: no se archiva ni se oculta (se vería desaparecer algo que sigue cobrando y avanzando). */
export function inProgress(i: Pick<LibraryItem, "kind" | "status" | "video_status">): boolean {
  if (i.status === "generating" || i.status === "authorized") return true;
  return i.kind === "v2" && (i.video_status === "queued" || i.video_status === "running" || i.video_status === "scheduled");
}

export function bucketOf(i: LibraryItem, now = Date.now()): LibraryBucket {
  if (inProgress(i)) return "en_curso";
  if (i.archived_at) return "archivado";
  if (isTestTitle(i.title)) return "prueba";
  if (i.status === "failed") return "fallido";
  if (i.status === "ready") return "listo";
  const age = now - Date.parse(i.updated_at || i.created_at);
  return age > STALE_DAYS * DAY ? "antiguo" : "borrador";
}

const ORDER: Record<LibraryBucket, number> = { en_curso: 0, listo: 1, borrador: 2, archivado: 3, fallido: 4, prueba: 5, antiguo: 6 };
/** Grupos que se ocultan solos (sin escribir nada): se ven en «Archivados» y no ofrecen archivar/restaurar a mano. */
export const AUTO_GROUPED: Partial<Record<LibraryBucket, string>> = {
  fallido: "Con error: se agrupa aquí automáticamente. Ábrelo para ver el motivo o reintentar.",
  prueba: "Episodio de prueba: se agrupa aquí automáticamente.",
  antiguo: "Sin terminar desde hace más de 7 días.",
};

/**
 * Lo que muestra cada vista como UNA sola secuencia (estudio y clásico mezclados), ordenada: en curso, luego lo
 * terminado, luego borradores recientes; dentro de cada grupo, la actividad más reciente arriba.
 */
export function libraryView<T extends LibraryItem>(items: T[], view: "principal" | "archivados", now = Date.now()): (T & { bucket: LibraryBucket })[] {
  const tagged = items.map((i) => ({ ...i, bucket: bucketOf(i, now) }));
  const hidden = (b: LibraryBucket) => b === "archivado" || b in AUTO_GROUPED;
  const keep = tagged.filter((i) => (view === "archivados" ? hidden(i.bucket) : !hidden(i.bucket)));
  return keep.sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket] || Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at));
}

export const ARCHIVE_COLUMN_MISSING = "Archivar requiere un cambio de base de datos que aún no está aplicado. No se ocultó nada.";

/** Archivar / restaurar un episodio propio. `setArchived` solo cambia `archived_at` de esa fila del dueño. */
export async function libraryAction(userId: string, body: unknown, deps: {
  load: (kind: LibraryKind, id: string) => Promise<(Pick<LibraryItem, "status" | "video_status"> & { user_id: string }) | null | "sin_columna">;
  setArchived: (kind: LibraryKind, id: string, at: string | null) => Promise<boolean>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const b = (body ?? {}) as { kind?: unknown; id?: unknown; action?: unknown };
  const kind = b.kind === "studio" || b.kind === "v2" ? b.kind : null;
  const id = typeof b.id === "string" && /^[0-9a-f-]{36}$/i.test(b.id) ? b.id : null;
  const action = b.action === "archive" || b.action === "restore" ? b.action : null;
  if (!kind || !id || !action) return { status: 400, body: { error: "Solicitud no válida." } };
  const row = await deps.load(kind, id);
  if (row === "sin_columna") return { status: 409, body: { error: ARCHIVE_COLUMN_MISSING } };
  // Un episodio ajeno se responde igual que uno inexistente (no se revela que existe).
  if (!row || row.user_id !== userId) return { status: 404, body: { error: "No encontramos ese episodio en tu cuenta." } };
  if (action === "archive" && inProgress({ kind, status: row.status, video_status: row.video_status })) return { status: 409, body: { error: "Este episodio se está produciendo; podrás archivarlo cuando termine." } };
  const ok = await deps.setArchived(kind, id, action === "archive" ? new Date().toISOString() : null);
  if (!ok) return { status: 409, body: { error: "No se pudo actualizar; vuelve a intentarlo." } };
  return { status: 200, body: { ok: true, archived: action === "archive" } };
}
