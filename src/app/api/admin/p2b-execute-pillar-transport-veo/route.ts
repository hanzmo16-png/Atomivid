import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

/**
 * P2B — endpoint ADMINISTRATIVO server-side para ejecutar, UNA sola vez,
 * la generación real autorizada de Google Veo (shot "Pillar Transport").
 * NUNCA es un endpoint público, NUNCA usa el sistema de auth normal de
 * usuarios (deliberado: esto es independiente de cualquier sesión de
 * usuario, nunca invocable por un usuario normal por más permisos que
 * tenga en la app) — solo responde si:
 *
 *   1. El token coincide EXACTO (comparación de tiempo constante) con
 *      process.env.P2B_ADMIN_EXECUTE_TOKEN — un secreto DISTINTO de
 *      VEO_API_KEY, configurado solo en Vercel, nunca en este repo ni
 *      pegado en ningún chat.
 *   2. El valor de confirmación coincide EXACTO con
 *      "EXECUTE_PILLAR_TRANSPORT_VEO_ONCE" — igual que el patrón ya usado
 *      en visual-test-v2-real (route.ts).
 *
 * SOLO POST, con header "x-p2b-admin-token" + body {"confirm": "..."} —
 * deliberadamente sin variante GET-con-querystring: un token en la URL
 * queda en el historial del navegador y en logs de servidores
 * intermedios, algo evitable aquí sin costo real (basta con una llamada
 * autenticada por header desde una terminal/cliente HTTP del propio Hans,
 * que nunca pasa por este chat).
 *
 * Toda la lógica de seguridad real (imagen aprobada, checksum, Cost
 * Guard por clip y de misión, VEO_API_KEY configurada, retries=0) vive en
 * p2b-pillar-transport-execution.ts — este archivo SOLO hace de: auth,
 * valida la confirmación, delega, nunca decide nada por su cuenta.
 *
 * Corre server-side en Vercel, donde VEO_API_KEY ya está configurada
 * (Hans) — esta ruta NUNCA la expone en la respuesta ni en logs.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300; // la generación + sondeo de Veo puede tardar varios minutos — ajustar según el plan de Vercel.

const CONFIRM_VALUE = "EXECUTE_PILLAR_TRANSPORT_VEO_ONCE";

function tokenMatches(provided: string | null): boolean {
  const expected = process.env.P2B_ADMIN_EXECUTE_TOKEN;
  if (!expected || !provided) return false; // sin secreto configurado, o sin token provisto -> nunca autorizado.
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) return false; // timingSafeEqual exige igual longitud.
  return timingSafeEqual(expectedBuf, providedBuf);
}

export async function POST(request: Request) {
  const authorized = tokenMatches(request.headers.get("x-p2b-admin-token"));
  if (!authorized) {
    // Mismo status/mensaje sin importar la razón exacta (token ausente, incorrecto, o secreto no configurado) — nunca revela cuál.
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }

  const rawBody: unknown = await request.json().catch(() => null);
  const isPlainObject = typeof rawBody === "object" && rawBody !== null;
  const keys = isPlainObject ? Object.keys(rawBody as Record<string, unknown>) : [];
  const confirm = isPlainObject ? (rawBody as Record<string, unknown>).confirm : undefined;
  const confirmed = keys.length === 1 && keys[0] === "confirm" && confirm === CONFIRM_VALUE;
  if (!confirmed) {
    return NextResponse.json({ error: "Falta o es incorrecto el valor de confirmación." }, { status: 400 });
  }

  const { executeP2BPillarTransportVeoOnce } = await import("@/lib/video/long-form/p2b-pillar-transport-execution");
  const result = await executeP2BPillarTransportVeoOnce();

  if (!result.preflightPassed) {
    return NextResponse.json(
      { preflightPassed: false, attempted: false, failures: result.failures },
      { status: 412, headers: { "Cache-Control": "private, no-store" } },
    );
  }
  return NextResponse.json(result, { status: result.success ? 200 : 502, headers: { "Cache-Control": "private, no-store" } });
}
