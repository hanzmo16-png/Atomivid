/**
 * Podcast — biblioteca limpia (T-20261030-1118). La lista mostraba al inicio pruebas, proyectos a medias y errores.
 * Nada se borra:
 *  - vista «Mis episodios»: una sola lista (estudio y clásico juntos): en curso primero, luego lo terminado y los
 *    borradores recientes, cada grupo por actividad más reciente (`updated_at`, o `created_at` si no hay);
 *  - un fallido que la persona puede recuperar sola (límite diario del avatar) se queda en «Mis episodios» («Necesita tu decisión»);
 *  - vista «Archivados»: lo que el dueño archivó y, sin escribir nada, los demás episodios con error, los de prueba
 *    (regla `isTestTitle`) y los borradores de hace más de 7 días;
 *  - archivar/restaurar solo marca `archived_at` (columna de supabase/migrations/20261030170000_podcast_library_archive.sql);
 *    nunca toca archivos, enlaces, costos ni el libro de gastos. Lo que está en producción no se puede archivar.
 */
export type LibraryKind = "studio" | "v2";
export type LibraryItem = { kind: LibraryKind; id: string; status: string; created_at: string; updated_at?: string | null; archived_at?: string | null; video_status?: string | null; title?: string | null; error?: string | null };
export type LibraryBucket = "en_curso" | "recuperable" | "listo" | "borrador" | "archivado" | "fallido" | "prueba" | "antiguo";

/**
 * ¿El error del episodio es el límite diario de llamadas del avatar? (texto de readinessMessage, con o sin números;
 * también el de producción anterior: «HeyGen (avatar): alcanzó su cuota diaria de llamadas.»).
 */
export const isAvatarQuotaError = (error: string | null | undefined) => !!error && /HeyGen \(avatar\)/.test(error) && /(llamadas|cuota diaria)/.test(error);

/**
 * Fallido que la persona puede recuperar ella misma desde la interfaz («Adaptar producción al límite disponible»,
 * incidente 4290175a): episodio del estudio bloqueado por el límite diario del avatar. No se esconde en «Archivados»
 * (allí nadie lo buscaba): sigue en «Mis episodios» marcado «Necesita tu decisión» hasta que se recupere o se archive a mano.
 */
export function recoverableFailure(i: Pick<LibraryItem, "kind" | "status" | "error">): boolean {
  return i.kind === "studio" && i.status === "failed" && isAvatarQuotaError(i.error);
}

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
  if (recoverableFailure(i)) return "recuperable";
  if (i.status === "failed") return "fallido";
  if (i.status === "ready") return "listo";
  const age = now - Date.parse(i.updated_at || i.created_at);
  return age > STALE_DAYS * DAY ? "antiguo" : "borrador";
}

const ORDER: Record<LibraryBucket, number> = { en_curso: 0, recuperable: 1, listo: 2, borrador: 3, archivado: 4, fallido: 5, prueba: 6, antiguo: 7 };

/** Nota de los grupos que SÍ se ven en «Mis episodios» pero piden algo a la persona. */
export const ACTION_NOTE: Partial<Record<LibraryBucket, string>> = {
  recuperable: "Necesita tu decisión: no se pudo producir por el límite diario de apariciones del avatar. Puedes adaptarlo aquí sin perder el guion ni la voz, o archivarlo.",
};
/** Grupos que se ocultan solos (sin escribir nada): se ven en «Archivados» y no ofrecen archivar/restaurar a mano. */
export const AUTO_GROUPED: Partial<Record<LibraryBucket, string>> = {
  fallido: "Con error: se agrupa aquí automáticamente. Ábrelo para ver el motivo o reintentar.",
  prueba: "Episodio de prueba: se agrupa aquí automáticamente.",
  antiguo: "Sin terminar desde hace más de 7 días.",
};

/** Motivo corto de cada grupo automático, para decir por qué un episodio sigue en «Archivados» tras quitar el archivo manual. */
const STAYS_BECAUSE: Partial<Record<LibraryBucket, string>> = {
  fallido: "tiene un error", prueba: "es un episodio de prueba", antiguo: "lleva más de 7 días sin terminar",
};

/**
 * Archivado a mano cuyo estado actual lo agruparía solo (fallido, prueba o borrador viejo): quitar el archivo manual NO lo
 * devuelve a «Mis episodios» (T-20261107-2314). Devuelve el aviso que se muestra ANTES de actuar, o `null` si al restaurar
 * vuelve a la vista principal (p. ej. un episodio listo). No cambia estado, costos ni archivos: solo explica el resultado.
 */
export function restoreNote(i: LibraryItem, now = Date.now()): string | null {
  if (!i.archived_at || inProgress(i)) return null;
  const reason = STAYS_BECAUSE[bucketOf({ ...i, archived_at: null }, now)];
  return reason ? `Quitar el archivo manual no lo devuelve a «Mis episodios»: seguirá en «Archivados» porque ${reason}. Puedes abrirlo cuando quieras; no se borra nada.` : null;
}

/**
 * Lo que muestra cada vista como UNA sola secuencia (estudio y clásico mezclados), ordenada: en curso, luego lo
 * terminado, luego borradores recientes; dentro de cada grupo, la actividad más reciente arriba.
 */
export function libraryView<T extends LibraryItem>(items: T[], view: "principal" | "archivados", now = Date.now()): (T & { bucket: LibraryBucket })[] {
  const tagged = items.map((i) => ({ ...i, bucket: bucketOf(i, now) }));
  const hidden = (b: LibraryBucket) => b === "archivado" || b in AUTO_GROUPED;
  const keep = tagged.filter((i) => (view === "archivados" ? hidden(i.bucket) : !hidden(i.bucket)));
  // Desempate por fuente e id: el orden es total y estable, así que paginar la vista nunca repite ni salta elementos.
  return keep.sort((a, b) => ORDER[a.bucket] - ORDER[b.bucket] || Date.parse(b.updated_at || b.created_at) - Date.parse(a.updated_at || a.created_at)
    || a.kind.localeCompare(b.kind) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/**
 * Paginación por cursor (updated_at, id), sin tope invisible (T-20261031-1910, B3). Antes cada fuente traía solo sus 100
 * episodios más recientes y el resto no aparecía en ninguna vista. `page(after, size)` devuelve la página siguiente ordenada
 * por updated_at DESC, id DESC con la condición (updated_at, id) < after; aquí se recorren todas hasta agotar la fuente.
 * `truncated` = la lista NO está completa y hay que decirlo (nunca se presenta como completa):
 *  - una página intermedia falló (se devuelve lo leído);
 *  - la fuente tiene MÁS de `maxRows` filas (tope de seguridad). Con exactamente `maxRows` no es truncada: al llegar al
 *    tope se pide 1 fila más y solo si existe (o si esa consulta falla) se marca (CORRECCION-1, sin falso positivo).
 * `null` = falló la primera página (p. ej. columna ausente): quien llama decide su alternativa, como antes.
 */
export type PageCursor = { updated_at: string; id: string };
export const LIBRARY_PAGE = 100, LIBRARY_MAX_ROWS = 5000;
export async function fetchAllByCursor<T extends { id: string; updated_at?: string | null }>(
  page: (after: PageCursor | null, size: number) => Promise<T[] | null>, size = LIBRARY_PAGE, maxRows = LIBRARY_MAX_ROWS,
): Promise<{ rows: T[]; truncated: boolean } | null> {
  const rows: T[] = [];
  let after: PageCursor | null = null;
  for (;;) {
    const chunk = await page(after, Math.min(size, maxRows - rows.length));
    if (!chunk) return rows.length ? { rows, truncated: true } : null;
    const want = Math.min(size, maxRows - rows.length);
    rows.push(...chunk.slice(0, want));
    if (chunk.length < want) return { rows, truncated: false };
    const last = rows[rows.length - 1];
    if (!last?.updated_at) return { rows, truncated: true };
    after = { updated_at: last.updated_at, id: last.id };
    if (rows.length >= maxRows) {
      const extra = await page(after, 1);
      return { rows, truncated: extra === null || extra.length > 0 };
    }
  }
}

/** Mínimo del cliente de Supabase que usa `ownerRowsByCursor` (permite probar los llamadores reales sin red). */
type OwnerQuery = PromiseLike<{ data: unknown; error: unknown }> & {
  eq(col: string, v: string): OwnerQuery; or(f: string): OwnerQuery; order(col: string, o: { ascending: boolean }): OwnerQuery; limit(n: number): OwnerQuery;
};
export type OwnerRowsClient = { from(table: string): { select(cols: string): OwnerQuery } };
/**
 * Todas las filas del dueño de una tabla de la biblioteca (estudio o clásico), por páginas: SIEMPRE con `user_id`, orden
 * (updated_at, id) DESC y el cursor de `afterCursorFilter`. Es la única consulta que usan `listStudioEpisodes` y la página.
 */
export async function ownerRowsByCursor<T extends { id: string; updated_at?: string | null }>(
  client: OwnerRowsClient, table: string, cols: string, userId: string, size = LIBRARY_PAGE, maxRows = LIBRARY_MAX_ROWS,
  onError?: (error: unknown) => void,
): Promise<{ rows: T[]; truncated: boolean } | null> {
  return fetchAllByCursor<T>(async (after, n) => {
    let q = client.from(table).select(cols).eq("user_id", userId);
    if (after) q = q.or(afterCursorFilter(after));
    const { data, error } = await q.order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(n);
    if (error) { onError?.(error); return null; }
    return data as T[];
  }, size, maxRows);
}

/**
 * La TABLA no existe (migración no aplicada): no es un fallo de lectura, la fuente simplemente no está. Solo el código o
 * mensaje de relación ausente; una COLUMNA ausente («column … does not exist», PGRST204) no cuenta.
 */
export function isMissingRelation(error: unknown): boolean {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  if (e.code === "42P01" || e.code === "PGRST205") return true;
  return typeof e.message === "string" && (/relation "[^"]+" does not exist/i.test(e.message) || /Could not find the table/i.test(e.message));
}

/**
 * Episodios clásicos del dueño (CORRECCION-2): con `archived_at` si la columna existe; si ese intento falla, sin ella
 * (respaldo legítimo, sin aviso). Si el intento FINAL falla en su primera página, la fuente no se da por vacía:
 * `failed` y `truncated` → la página avisa y nunca muestra la biblioteca vacía como completa.
 */
export async function listClassicEpisodes<T extends { id: string; updated_at?: string | null }>(
  client: OwnerRowsClient, userId: string, cols: string,
): Promise<{ rows: T[]; truncated: boolean; archiveReady: boolean; failed: boolean }> {
  const withArchive = await ownerRowsByCursor<T>(client, "podcast_episodes", `${cols},archived_at`, userId);
  if (withArchive) return { ...withArchive, archiveReady: true, failed: false };
  const plain = await ownerRowsByCursor<T>(client, "podcast_episodes", cols, userId);
  return plain ? { ...plain, archiveReady: false, failed: false } : { rows: [], truncated: true, archiveReady: false, failed: true };
}

/** Aviso visible y no destructivo cuando alguna fuente quedó incompleta (nunca se presenta la lista como completa). */
export function incompleteLibraryNotice(sources: { studio: boolean; classic: boolean }): string | null {
  const which = [sources.studio && "de estudio", sources.classic && "clásicos"].filter(Boolean).join(" y ");
  return which ? `No pudimos cargar todos tus episodios ${which}: esta lista puede estar incompleta. No se borró ni ocultó nada; recarga la página para volver a intentarlo.` : null;
}
/** Filtro PostgREST de la página siguiente: (updated_at, id) < cursor, con el orden updated_at DESC, id DESC. */
export const afterCursorFilter = (c: PageCursor) => `updated_at.lt."${c.updated_at}",and(updated_at.eq."${c.updated_at}",id.lt.${c.id})`;

/** Cuántos elementos de la vista se muestran (de 50 en 50, «Ver más»); el orden total hace estable cada corte. */
export const VIEW_STEP = 50;
export const shownCount = (raw: string | string[] | undefined, total: number) => {
  const n = Math.floor(Number(Array.isArray(raw) ? raw[0] : raw));
  return Math.min(total, Math.max(VIEW_STEP, Number.isFinite(n) ? Math.ceil(n / VIEW_STEP) * VIEW_STEP : VIEW_STEP));
};

export const ARCHIVE_COLUMN_MISSING = "Archivar requiere un cambio de base de datos que aún no está aplicado. No se ocultó nada.";

/** Archivar / restaurar un episodio propio. `setArchived` solo cambia `archived_at` de esa fila del dueño. */
export async function libraryAction(userId: string, body: unknown, deps: {
  load: (kind: LibraryKind, id: string) => Promise<(Pick<LibraryItem, "status" | "video_status" | "archived_at"> & { user_id: string }) | null | "sin_columna">;
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
  // Idempotente (B2): repetir «archivar» no reescribe la fecha y repetir «restaurar» no escribe nada.
  const want = action === "archive";
  if (!!row.archived_at === want) return { status: 200, body: { ok: true, archived: want, unchanged: true } };
  const ok = await deps.setArchived(kind, id, want ? new Date().toISOString() : null);
  if (!ok) {
    // Dos peticiones a la vez: la escritura condicional de la otra ya dejó el estado pedido → misma respuesta, sin reescribir.
    const again = await deps.load(kind, id);
    if (again && again !== "sin_columna" && again.user_id === userId && !!again.archived_at === want) return { status: 200, body: { ok: true, archived: want, unchanged: true } };
    return { status: 409, body: { error: "No se pudo actualizar; vuelve a intentarlo." } };
  }
  return { status: 200, body: { ok: true, archived: want } };
}
