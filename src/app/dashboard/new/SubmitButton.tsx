"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/Button";

/** useFormStatus solo funciona dentro de un <form>, por eso es un componente aparte. */
export function SubmitButton({ disabledReason = null }: { disabledReason?: string | null } = {}) {
  const { pending } = useFormStatus();
  return (
    <div className="space-y-1.5">
      <Button type="submit" loading={pending} disabled={Boolean(disabledReason)} className="w-full" size="lg" aria-describedby={disabledReason ? "submit-blocked" : undefined}>
        {pending ? "Guardando solicitud…" : "Crear solicitud"}
      </Button>
      {disabledReason && <p id="submit-blocked" role="status" className="text-center text-xs text-ink-muted">{disabledReason}</p>}
    </div>
  );
}
