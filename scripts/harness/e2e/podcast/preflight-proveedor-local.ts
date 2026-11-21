/**
 * P0 4290175a — prueba de integración LOCAL (base desechable del arnés, 127.0.0.1; USD 0, sin proveedores).
 * Ejecuta la verificación previa real (studioSupplyCheck → ensureJobSupplyReady → RPC pi_supply_state/pi_supply_spend de
 * las migraciones) con la demanda EXACTA del incidente (registro del run 42504283810) y la política de HeyGen de
 * producción (max_daily_calls 40). Con saldos verificados, comprueba también que la verificación no escribe nada.
 * Uso: con la pila del arnés levantada, `env $(cat $E2E_HOME/secrets/podcast-worker.env) npx tsx <este archivo>`.
 */
import { createClient } from "@supabase/supabase-js";
import { studioSupplyCheck, readinessMessage } from "../../../../src/lib/podcast/v3/readiness";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "", key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!/^http:\/\/127\.0\.0\.1:\d+/.test(url) || !key) { console.error("SOLO_ARNES_LOCAL: se niega a correr fuera de 127.0.0.1"); process.exit(2); }
const db = createClient(url, key, { auth: { persistSession: false } });
const results: { check: string; ok: boolean; detail?: unknown }[] = [];
const check = (name: string, ok: boolean, detail?: unknown) => { results.push({ check: name, ok, detail }); console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail)); };

async function counts() {
  const out: Record<string, number | null> = {};
  for (const t of ["pi_capacity_snapshots", "pi_supply_alerts", "pi_provider_accounts", "pi_supply_policies", "podcast_studio_operations"]) {
    const { count } = await db.from(t).select("*", { count: "exact", head: true }); out[t] = count ?? null;
  }
  return out;
}

async function main() {
  // Política de HeyGen como la de producción (cuota diaria 40) y saldo verde como en el registro (free 109.5).
  const pol = { enabled: true, unit: "usd", baseline: 109.5, unit_cost_usd: 1, daily_forecast: 1, daily_cap_usd: 50, monthly_cap_usd: 200, max_concurrent: 2, max_daily_calls: 40, free_daily_cap_usd: 0, timezone: "America/Cancun", evidence: "arnés local P0 4290175a (USD 0)" };
  const up = await db.from("pi_supply_policies").upsert({ provider: "heygen", ...pol }, { onConflict: "provider" });
  if (up.error) throw new Error(`seed heygen: ${up.error.message}`);
  // Saldos verificados y recientes (ElevenLabs al 90 % de su línea base del arnés): no hace falta refrescar, sin red.
  await db.from("pi_capacity_snapshots").insert({ provider: "elevenlabs", unit: "character", available: 900000, reserved: 0, pending: 0, health: "OK", reliability: "manual_entry", status: "GREEN", checked_at: new Date().toISOString() });
  await db.from("pi_capacity_snapshots").insert({ provider: "heygen", unit: "usd", available: 109.5, reserved: 0, pending: 0, health: "OK", reliability: "manual_entry", status: "GREEN", checked_at: new Date().toISOString() });

  // Demanda del incidente (STUDIO_READINESS del run 42504283810), sin Recraft (solo para aislar HeyGen).
  const incident = { ttsChars: 18865, ttsUsd: 3.773, avatarUsd: 23.01, imagesUsd: 0, ttsCalls: 96, avatarCalls: 48, imagesCalls: 0 };
  const before = await counts();
  const r = await studioSupplyCheck(db, incident);
  const after = await counts();
  check("48 llamadas de HeyGen con límite diario 40 → bloqueado antes de iniciar", r.ready === false && r.failure?.provider === "heygen" && r.failure?.reason === "daily request quota", r.failure);
  check("la cuota trae los números reales (máx 40, pedidas 48)", r.failure?.quota?.max === 40 && r.failure?.quota?.calls === 48, r.failure?.quota);
  const msg = readinessMessage(r.failure);
  check("mensaje: no cabe en un día aunque se espere (no promete «mañana»)", /necesita 48 llamadas y el límite diario de la plataforma es 40; no cabe en un día aunque se espere/.test(msg), msg);
  check("con saldos verificados, la verificación no escribe nada (instantáneas, alertas, cuentas, políticas, libro)", JSON.stringify(before) === JSON.stringify(after), { before, after });

  const small = await studioSupplyCheck(db, { ...incident, avatarCalls: 12 });
  check("el mismo episodio con 12 planos de avatar cabe → listo", small.ready === true, small.failure ?? null);

  // Con la tabla del libro inaccesible, la API falla cerrado (no se inicia).
  const broken = createClient(url, "clave-invalida", { auth: { persistSession: false } });
  let closed = false; try { const x = await studioSupplyCheck(broken, incident); closed = x.ready === false; } catch { closed = true; }
  check("sin poder leer el gasto/políticas → no listo (falla cerrado)", closed);

  const failed = results.filter((x) => !x.ok).length;
  console.log(`RESULTADO ${failed ? "FAIL" : "PASS"} ${results.length - failed}/${results.length}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("ERROR", e instanceof Error ? e.message : e); process.exit(1); });
