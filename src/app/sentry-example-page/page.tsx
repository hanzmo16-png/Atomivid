"use client";

/**
 * Página temporal, solo para verificar por única vez que la integración de
 * Sentry (ver src/instrumentation.ts) realmente manda errores reales a
 * sentry.io — bórrala (esta carpeta y api/sentry-example-api/) una vez
 * confirmado, junto con la otra ruta.
 */
export default function SentryExamplePage() {
  return (
    <main style={{ padding: 40, fontFamily: "sans-serif" }}>
      <h1>Prueba de Sentry</h1>
      <p>Dispara un error de servidor y uno de navegador para confirmar que llegan a Sentry.</p>
      <button
        type="button"
        style={{ padding: "12px 20px", fontSize: 16 }}
        onClick={async () => {
          await fetch("/api/sentry-example-api").catch(() => {});
          throw new Error("Error de prueba de Sentry (navegador) — esta página es temporal.");
        }}
      >
        Disparar error de prueba
      </button>
    </main>
  );
}
