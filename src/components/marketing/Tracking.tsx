"use client";

import { useEffect, type ReactNode } from "react";
import type { MarketingCta } from "@/lib/marketing/events";

function send(payload: Record<string, string>) {
  try {
    const body = JSON.stringify(payload);
    // keepalive lets a click signal survive the navigation it triggers.
    void fetch("/api/m", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => undefined);
  } catch { /* measurement never blocks the page */ }
}

/** One landing view per visitor and day (the server deduplicates); carries the campaign parameters once. */
export function LandingView() {
  useEffect(() => { send({ event: "landing_view", search: window.location.search }); }, []);
  return null;
}

/** Reports a click on a known call to action, then lets the link navigate normally. */
export function TrackCta({ cta, children }: { cta: MarketingCta; children: ReactNode }) {
  return <span className="contents" onClickCapture={() => send({ event: "cta_click", cta })}>{children}</span>;
}
