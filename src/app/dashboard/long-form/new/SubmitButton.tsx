"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/Button";

/**
 * QA real (2026-09-25, "GENERAR GUION NO HACE NADA EN PRODUCTION"): el
 * botón de este formulario no daba NINGÚN feedback mientras la llamada
 * real a Claude generaba el guion documental (hasta 8000 tokens de
 * salida, potencialmente decenas de segundos) — un submit lento se veía
 * indistinguible de "no pasó nada", y nada impedía pulsarlo dos veces.
 * useFormStatus() (React 19/Next.js, ver guía de forms) da el mismo
 * estado pending que ya usa GenerateButton.tsx para Reel/Avatar (loading
 * + disabled), sin convertir todo el formulario — ni el resto de sus
 * campos — en un componente cliente.
 */
export function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="w-full" loading={pending} disabled={pending}>
      {pending ? "Generando guion…" : "Generar guion"}
    </Button>
  );
}
