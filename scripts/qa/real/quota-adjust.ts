/**
 * Ajuste JUSTIFICADO de cuotas internas de llamadas (no de dinero) para Podcast Studio, autorizado por el dueño el
 * 2026-10-28 («las cuotas internas pueden ajustarse justificadamente dentro de los topes monetarios vigentes»).
 * Compare-and-set: solo cambia max_daily_calls si el valor actual es exactamente el esperado; daily_cap_usd,
 * monthly_cap_usd, max_concurrent y enabled no se tocan. MODO=dry no escribe.
 */
import { createClient } from "@supabase/supabase-js";
const CHANGES = [
  { provider: "elevenlabs", from: 14, to: 300, why: "Podcast Studio hace una llamada de voz por turno (episodio de 30 min ≈ 230); 14/día detuvo un episodio de 2 identidades a mitad (STUDIO_CAP daily request quota, 2026-10-28). Topes USD 20/día y 150/mes sin cambio." },
  { provider: "heygen", from: 4, to: 40, why: "Podcast Studio hace un clip por aparición de avatar (4 por episodio corto de 2 identidades); 4/día permitía un solo episodio al día. Topes USD 20/día y 150/mes sin cambio." },
];
async function main() {
  const apply = process.env.MODO === "apply";
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  for (const c of CHANGES) {
    const { data: before } = await db.from("pi_supply_policies").select("provider,enabled,max_daily_calls,daily_cap_usd,monthly_cap_usd,max_concurrent,evidence").eq("provider", c.provider).single();
    console.log("BEFORE", JSON.stringify({ ...before, evidence: `${String(before?.evidence ?? "").length} chars` }));
    if (!before || before.max_daily_calls !== c.from) { console.log(`SKIP ${c.provider}: max_daily_calls is ${before?.max_daily_calls}, expected ${c.from}`); continue; }
    if (!apply) { console.log(`DRY ${c.provider}: ${c.from} → ${c.to}`); continue; }
    const evidence = `${before.evidence}\n[2026-10-28 max_daily_calls ${c.from}→${c.to}] ${c.why}`;
    const { data: after, error } = await db.from("pi_supply_policies").update({ max_daily_calls: c.to, evidence, updated_at: new Date().toISOString() })
      .eq("provider", c.provider).eq("max_daily_calls", c.from).select("provider,enabled,max_daily_calls,daily_cap_usd,monthly_cap_usd,max_concurrent").single();
    if (error) throw new Error(`${c.provider}: ${error.message}`);
    console.log("AFTER", JSON.stringify(after));
    if (after.daily_cap_usd !== before.daily_cap_usd || after.monthly_cap_usd !== before.monthly_cap_usd || after.max_concurrent !== before.max_concurrent || after.enabled !== before.enabled) throw new Error("money/concurrency fields changed unexpectedly");
  }
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
