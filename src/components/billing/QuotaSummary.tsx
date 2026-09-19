import { createClient } from "@/lib/supabase/server";
import { monthlyVideoLimit, monthStartUtc } from "@/lib/billing/quota-window";
export async function QuotaSummary() {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  const { count, error } = await db.from("video_requests").select("id", { count: "exact", head: true })
    .eq("user_id", user.id).in("status", ["processing", "completed"]).gte("created_at", monthStartUtc());
  const limit = monthlyVideoLimit();
  const checked = new Date().toLocaleString("es-MX", { timeZone: "UTC" });
  return <section aria-label="Cupo de videos" className="my-4 space-y-2 rounded-lg border border-border p-4 text-sm">
    <p className="font-semibold">Cupo mensual: {limit} videos por cuenta</p>
    {error || count === null ? <p>No pudimos consultar el cupo disponible. Recarga para intentarlo de nuevo; no asumimos que tengas cupo libre.</p>
      : <p>Disponibles al consultar: <strong>{Math.max(0, limit - count)}</strong> de {limit}. En proceso o terminados: {count}.</p>}
    <p>Actualizado al cargar esta página: {checked} UTC. No se actualiza en tiempo real ni reserva lugares. Se comprueba de nuevo al solicitar la generación; otra solicitud puede cambiar el cupo.</p>
    <p>Se cuentan las solicitudes creadas este mes que están en proceso o terminadas. El periodo cambia el día 1 a las 00:00 UTC; las solicitudes pendientes y fallidas no cuentan. El cupo no sustituye una suscripción activa ni el permiso de acceso a la beta.</p>
  </section>;
}
