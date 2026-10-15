/**
 * What the customer can do after a failure, decided where the error is classified (by its type, never by the
 * wording shown): "retry" when repeating can help, "support" when only an operator can fix the cause.
 *
 * `video_requests` has no typed column for it (adding one needs a migration), so a stored failure carries the
 * action as a fixed machine tag in front of the customer text. Every reader goes through decodeStoredFailure /
 * renderFailureMessage, which strip the tag: the customer never sees it and the decision never reads the prose.
 */
export type FailureAction = "retry" | "support";

const SUPPORT_TAG = "[[action:support]] ";

export function encodeStoredFailure(message: string, action: FailureAction): string {
  return action === "support" ? `${SUPPORT_TAG}${message}` : message;
}

export function decodeStoredFailure(stored: string): { action: FailureAction | null; message: string } {
  return stored.startsWith(SUPPORT_TAG)
    ? { action: "support", message: stored.slice(SUPPORT_TAG.length) }
    : { action: null, message: stored };
}
