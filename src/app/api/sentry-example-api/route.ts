/**
 * Ruta temporal, ver src/app/sentry-example-page/page.tsx — borrar ambas
 * juntas una vez confirmado que Sentry captura este error de servidor.
 */
export async function GET() {
  throw new Error("Error de prueba de Sentry (servidor) — esta ruta es temporal.");
}
