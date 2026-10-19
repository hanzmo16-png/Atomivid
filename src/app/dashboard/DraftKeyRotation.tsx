"use client";

import { useEffect } from "react";
import { browserStorage, rotateDraftKey } from "./new/draft-key";

/** On a confirmed creation, the next «new video» starts a new draft (see draft-key.ts). Renders nothing. */
export function DraftKeyRotation({ draft }: { draft?: string }) {
  useEffect(() => { rotateDraftKey(browserStorage(), draft); }, [draft]);
  return null;
}
