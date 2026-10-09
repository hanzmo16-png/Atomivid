import type { ReactNode } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Field, INPUT_CLASS } from "@/components/ui/Field";

/**
 * Interest-list form shared by the public lists (email + explicit consent + honeypot). After submitting,
 * the page shows the confirmation instead of the form; a repeated email is acknowledged, never duplicated.
 */
export function InterestForm({ action, registrado, error, consent }: {
  action: (formData: FormData) => Promise<void>;
  registrado?: string;
  error?: string;
  consent: ReactNode;
}) {
  if (registrado === "1" || registrado === "ya") {
    return (
      <div className="mt-5">
        <Alert tone="success" role="status">
          {registrado === "ya" ? "Este correo ya estaba en la lista. No tienes que hacer nada más." : "Tu solicitud quedó registrada. Te escribiremos cuando haya lugar."}
        </Alert>
      </div>
    );
  }
  return (
    <form action={action} className="mt-5 space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <Field id="email" label="Correo electrónico">
        <input id="email" name="email" type="email" required autoComplete="email" className={INPUT_CLASS} placeholder="tu@correo.com" />
      </Field>
      {/* Honeypot: hidden from people and assistive tech; automated form fillers tend to complete it. */}
      <div className="hidden" aria-hidden="true">
        <label htmlFor="website">Sitio web</label>
        <input id="website" name="website" type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <label className="flex items-start gap-2 text-sm text-ink-muted">
        <input type="checkbox" name="consent" required className="mt-1" />
        <span>{consent}</span>
      </label>
      <Button type="submit" className="w-full">Apuntarme a la lista</Button>
    </form>
  );
}
