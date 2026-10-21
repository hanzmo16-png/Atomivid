"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

/**
 * Re-signs the download/playback links of a finished video by re-rendering the owner-checked Server
 * Component (router.refresh). Only a GET of the same page: it never starts, resumes or renders a
 * production and calls no provider. The transition keeps the button disabled until the new links
 * arrive, so a double click cannot queue a second refresh.
 */
export function RefreshLinksButton({ note }: { note: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <Button
        type="button"
        variant="secondary"
        disabled={pending}
        aria-busy={pending}
        data-testid="refresh-links"
        onClick={() => startTransition(() => router.refresh())}
      >
        {pending ? "Actualizando enlaces…" : "Actualizar enlaces"}
      </Button>
      <p className="text-xs text-ink-muted">{note}</p>
    </div>
  );
}
