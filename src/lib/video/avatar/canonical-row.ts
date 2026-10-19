/**
 * Return the single avatar row that owns a photo claim.
 *
 * The database unique index is the authority. A contender that loses the INSERT race
 * must load the canonical row instead of inventing another local avatar or retrying the
 * provider call.
 */
type DbError = { code?: string | null };
type DbResult<T> = { data: T | null; error: DbError | null };

export async function insertCanonicalAvatar<T>(
  insert: () => PromiseLike<DbResult<T>>,
  loadCanonical: () => PromiseLike<DbResult<T>>,
): Promise<T | null> {
  const created = await insert();
  if (!created.error) return created.data;
  if (created.error.code !== "23505") return null;

  const canonical = await Promise.resolve(loadCanonical()).catch(() => null);
  return canonical && !canonical.error ? canonical.data : null;
}
