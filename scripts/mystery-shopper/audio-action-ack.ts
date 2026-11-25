/** A browser click is not proof of an accepted API operation. Never resend on ambiguity. */
export async function audioActionAck(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- worker-supplied Playwright or controlled double
  page: any, projectId: string, action: "listo" | "generar", click: () => Promise<void>,
): Promise<{ state: "PASS" | "FAIL" | "BLOCKED"; detail: string }> {
  const response = page.waitForResponse((r: { url(): string; request(): { method(): string; postDataJSON(): { action?: string } } }) => {
    try { return new URL(r.url()).pathname === `/api/audio-studio/projects/${projectId}` && r.request().method() === "POST" && r.request().postDataJSON()?.action === action; } catch { return false; }
  }, { timeout: 30000 }).catch(() => null);
  await click();
  const r = await response;
  if (!r) return { state: "BLOCKED", detail: "No se confirmó respuesta de la acción; no se reenvía ni se libera reserva por asumir que no hubo gasto." };
  if (!r.ok()) return { state: "FAIL", detail: `La API rechazó la acción (HTTP ${r.status()}); no se publica su cuerpo privado.` };
  const body = await r.json().catch(() => null);
  if (!body?.generation || (action === "generar" && !["en_cola", "generando", "terminada"].includes(body.generation.status))) return { state: "FAIL", detail: "La API no confirmó una generación aceptada; no se declara iniciada por un clic." };
  return { state: "PASS", detail: "Acción confirmada por la API; el archivo final todavía requiere validación." };
}
