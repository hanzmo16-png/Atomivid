/**
 * Draft key of the «new video» form (PR #149, corrección 2). Browser side, storage injected so it is testable.
 *
 * One key per DRAFT, shared by every tab of this browser (localStorage is per origin, not per tab): two tabs, a
 * reload or a lost response re-submit the same key, and the server (submission-key.ts) maps the same key and
 * intent to the same request. The key changes only when the server confirmed the request exists (rotateDraftKey,
 * on /dashboard?created=1&draft=<key>), and only if it is still the key that was used — a newer draft is never
 * discarded. Without storage (private mode, blocked site data) each tab keeps its own key: the server still
 * dedupes repeats of that tab, never more than before.
 */
export const DRAFT_KEY_STORAGE = "atomivid:new-video:draft-key";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type KeyStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : "";
}

/** The current draft key, created and stored if there is none. `fallback` is used when storage throws. */
export function readOrCreateDraftKey(storage: KeyStorage | null, fallback: string, make: () => string = newKey): string {
  try {
    if (!storage) return fallback;
    const current = storage.getItem(DRAFT_KEY_STORAGE);
    if (current && UUID.test(current)) return current;
    const fresh = make();
    if (!fresh) return fallback;
    storage.setItem(DRAFT_KEY_STORAGE, fresh);
    // Two tabs creating at the same instant: the last write wins and both read it back.
    return storage.getItem(DRAFT_KEY_STORAGE) || fresh;
  } catch {
    return fallback;
  }
}

/** After a CONFIRMED creation: forget the key that was used, never a newer one. */
export function rotateDraftKey(storage: KeyStorage | null, usedKey: string | null | undefined): boolean {
  try {
    if (!storage || !usedKey || !UUID.test(usedKey)) return false;
    if (storage.getItem(DRAFT_KEY_STORAGE)?.toLowerCase() !== usedKey.toLowerCase()) return false;
    storage.removeItem(DRAFT_KEY_STORAGE);
    return true;
  } catch {
    return false;
  }
}

export function browserStorage(): KeyStorage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
