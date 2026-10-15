/**
 * Dependency-free (safe for client components): the prefix of every script error message that must NOT offer a
 * retry, because the provider outcome of the previous call is uncertain and a retry could charge twice.
 */
export const SCRIPT_NO_RETRY_PREFIX = "No reintentes:";
export const isNoRetryScriptMessage = (message: string | null | undefined) => !!message?.startsWith(SCRIPT_NO_RETRY_PREFIX);
