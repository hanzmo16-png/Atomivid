"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/Button";

/** useFormStatus solo funciona dentro de un <form>, por eso es un componente aparte. */
export function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} className="w-full" size="lg">
      {pending ? "Guardando solicitud…" : "Guardar y continuar"}
    </Button>
  );
}
