/**
 * Podcast — biblioteca limpia (T-20261030-1118). La lista mostraba al inicio pruebas, proyectos a medias y errores.
 * Nada se borra:
 *  - vista «Mis episodios»: lo que está en curso, lo terminado y los fallos recientes (para poder reintentar);
 *  - vista «Archivados»: lo que el dueño archivó y, sin escribir nada, los borradores y fallos de hace más de 7 días;
 *  - archivar/restaurar solo marca `archived_at` (columna propuesta en supabase/proposals/20261030170000_podcast_library_archive.sql);
 *    nunca toca archivos, enlaces, costos ni el libro de gastos. Lo que está en producción no se puede archivar.
 */
export type LibraryKind = "studio" | "v2";
export type LibraryItem = { kind: LibraryKind; id: string; status: string; created_at: string; updated_at?: string | null; archived_at?: string | null; video_status?: string | null };
export type LibraryBucket = "en_curso" | "listo" | "fallo_reciente" | "borrador" | "archivado" | "antiguo";

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
  if (i.status === "ready") return "listo";
  const age = now - Date.parse(i.updated_at || i.created_at);
  if (age > STALE_DAYS * DAY) return "antiguo";
  return i.status === "failed" ? "fallo_reciente" : "borrador";
}

const ORDER: Record<LibraryBucket, number> = { en_curso: 0, listo: 1, fallo_reciente: 2, borrador: 3, archivado: 4, antiguo: 5 };

/** Lo que muestra cada vista, ordenado: en curso primero, luego lo terminado (lo más reciente arriba). */
export function libraryView<T extends LibraryItem>(items: T[], view: "principal" | "archivados", now = Date.now()): (T & { bucket: LibraryBucket })[] {
  const tagged = items.map((i) => ({ ...i, bucket: bucketOf(i, now) }));
  const keep = tagged.filter((i) => (view === "archivados" ? i.bucket === "archivado" || i.bucket === "antiguo" : i.bucket !== "archivado" && i.bucket !== "antiguo"));
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
