"use client";

import { useState } from "react";
import * as Sentry from "@sentry/nextjs";

/**
 * Página temporal, solo para verificar por única vez que la integración de
 * Sentry (ver src/instrumentation.ts) realmente manda errores reales a
 * sentry.io — bórrala (esta carpeta y api/sentry-example-api/) una vez
 * confirmado, junto con la otra ruta.
 *
 * Usa Sentry.captureException() explícito (no solo un `throw` sin capturar)
 * para no depender de que el navegador reporte la promesa rechazada como
 * "unhandled" — y muestra confirmación en pantalla, porque disparar el
 * error no produce ningún efecto visible por sí solo.
 */
export default function SentryExamplePage() {
  const [status, setStatus] = useState<string | null>(null);

  return (
    <main
      style={{
        padding: 40,
        fontFamily: "sans-serif",
        color: "white",
        backgroundColor: "black",
        minHeight: "100vh",
      }}
    >
      <h1>Prueba de Sentry</h1>
      <p>Dispara un error de servidor y uno de navegador para confirmar que llegan a Sentry.</p>
      <button
        type="button"
        style={{
          padding: "12px 20px",
          fontSize: 16,
          backgroundColor: "#7c6aef",
          color: "white",
          border: "none",
          borderRadius: 8,
        }}
        onClick={async () => {
          setStatus("Disparando...");
          await fetch("/api/sentry-example-api").catch(() => {});
          Sentry.captureException(
            new Error("Error de prueba de Sentry (navegador) — esta página es temporal."),
          );
          setStatus("✅ Listo — revisa la pestaña Issues en Sentry en unos segundos.");
        }}
      >
        Disparar error de prueba
      </button>
      {status && <p style={{ marginTop: 20 }}>{status}</p>}
    </main>
  );
}
