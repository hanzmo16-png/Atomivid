"use client";

import { useEffect, useRef, useState } from "react";
import { ONBOARDING_STEPS, clampStep } from "@/lib/onboarding/steps";

const STORAGE_KEY = "atomivid_onboarding_completed_v1";

function readCompleted(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // localStorage puede fallar (modo privado, storage bloqueado) — no es
    // información sensible, así que si falla simplemente se vuelve a
    // mostrar el onboarding en la próxima visita, sin romper la página.
    return false;
  }
}

function writeCompleted() {
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    // Ignorar: el peor caso es que el onboarding reaparezca — no hay nada
    // sensible que proteger aquí.
  }
}

/**
 * Onboarding de primera visita + botón de ayuda flotante para reabrirlo.
 * No bloquea el dashboard de forma permanente (siempre se puede omitir) y
 * no depende de ninguna tabla ni migración nueva — solo localStorage, sin
 * datos sensibles.
 */
export function Onboarding() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // localStorage no existe durante el render en servidor, así que la
    // primera visita solo puede detectarse aquí, en un efecto de montaje —
    // no hay forma de evitar este setState síncrono sin romper el SSR.
    if (!readCompleted()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- ver comentario arriba
      setOpen(true);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        close();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [open]);

  function close() {
    writeCompleted();
    setOpen(false);
    setStep(0);
  }

  function openFresh() {
    setStep(0);
    setOpen(true);
  }

  const current = ONBOARDING_STEPS[step];
  const isLast = step === ONBOARDING_STEPS.length - 1;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={openFresh}
        className="fixed bottom-5 right-5 z-30 flex size-11 items-center justify-center rounded-full border border-border-strong bg-surface-raised text-ink-muted shadow-lg transition-colors hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
        aria-label="Ver cómo funciona Atomivid"
        title="Ayuda: cómo funciona"
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M10 2a8 8 0 100 16 8 8 0 000-16zm.75 12h-1.5v-1.5h1.5V14zm.02-3.34a1 1 0 00-.52.9V12h-1.5v-.44a2.5 2.5 0 011.3-2.24c.55-.3.9-.62.9-1.12a1 1 0 00-1-1 1 1 0 00-1 1H6.5a2.5 2.5 0 015 0c0 1.1-.65 1.7-1.23 2.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 p-4 sm:items-center">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="onboarding-title"
            tabIndex={-1}
            className="w-full max-w-sm rounded-lg border border-border-strong bg-surface-raised p-6 shadow-lg outline-none"
          >
            <div className="flex items-center gap-1.5" aria-hidden="true">
              {ONBOARDING_STEPS.map((s, i) => (
                <span
                  key={s.title}
                  className={`h-1 flex-1 rounded-full ${i <= step ? "bg-accent" : "bg-border-strong"}`}
                />
              ))}
            </div>

            <p className="mt-5 text-xs font-medium text-accent">
              Paso {step + 1} de {ONBOARDING_STEPS.length}
            </p>
            <h2 id="onboarding-title" className="mt-1 text-lg font-semibold text-ink">
              {current.title}
            </h2>
            <p className="mt-2 text-sm text-ink-muted">{current.body}</p>

            <div className="mt-6 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={close}
                className="text-sm font-medium text-ink-faint hover:text-ink-muted"
              >
                Omitir
              </button>
              <div className="flex gap-2">
                {step > 0 && (
                  <button
                    type="button"
                    onClick={() => setStep((s) => clampStep(s - 1, ONBOARDING_STEPS.length))}
                    className="rounded-md border border-border-strong px-3.5 py-2 text-sm font-medium text-ink hover:bg-surface"
                  >
                    Atrás
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    isLast ? close() : setStep((s) => clampStep(s + 1, ONBOARDING_STEPS.length))
                  }
                  className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-ink hover:bg-accent-hover"
                >
                  {isLast ? "Empezar" : "Siguiente"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
