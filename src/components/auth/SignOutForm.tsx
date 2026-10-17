"use client";

import type { ReactNode } from "react";
import { clearAllDrafts } from "@/lib/podcast/production-contract";

/** Sign-out form that first clears the tab's podcast drafts, so nothing typed stays for the next account. */
export function SignOutForm({ action, children }: { action: () => void | Promise<void>; children: ReactNode }) {
  return (
    <form action={action} onSubmit={() => { try { clearAllDrafts(window.sessionStorage); } catch { /* storage unavailable: nothing stored */ } }}>
      {children}
    </form>
  );
}
