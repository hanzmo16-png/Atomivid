"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/Button";

/**
 * Botón de envío que se bloquea mientras su formulario está enviando. Sin esto, un doble toque en el móvil
 * enviaba dos veces la misma Server Action: dos altas (cada una gasta un correo de confirmación de la cuota
 * del proyecto en Supabase) o dos sesiones de Checkout. useFormStatus solo funciona dentro del <form>.
 */
export function PendingSubmitButton({ children, pendingLabel, className = "w-full", variant }: {
  children: ReactNode;
  pendingLabel: string;
  className?: string;
  variant?: "primary" | "secondary";
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} className={className} variant={variant}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
