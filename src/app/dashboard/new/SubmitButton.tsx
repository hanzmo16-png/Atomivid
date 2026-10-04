"use client";

import { useFormStatus } from "react-dom";
import { GenerationProgress } from "@/components/ui/GenerationProgress";
import { Button } from "@/components/ui/Button";

/** useFormStatus solo funciona dentro de un <form>, por eso es un componente aparte. */
export function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <div className="w-full">
    <Button type="submit" loading={pending} className="w-full" size="lg">
      {pending ? "Guardando solicitud…" : "Crear solicitud"}
    </Button>
    {pending && <GenerationProgress label="Preparando solicitud y archivos" />}
    </div>
  );
}
