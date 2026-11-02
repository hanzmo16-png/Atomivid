// USD 0, SOLO LECTURA: incidente «Base Dulce» (2026-11-02). Reconstruye desde el libro REAL de la plataforma qué pasos del
// guion largo (studio-script:<dueño>:<trabajo>) se pidieron, cuáles se cobraron, qué devolvió cada uno (solo métricas:
// turnos, caracteres, motivo de parada, turnos repetidos y su posición) y qué consumió la cuota diaria de Anthropic.
// No imprime textos, prompts, correos ni el id del dueño (se reemplaza por <dueño>). Nada se escribe.
import { createClient } from "@supabase/supabase-js";

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const out = (k, v) => console.log(`${k} ${JSON.stringify(v)}`);
const OWNER = process.env.OWNER_ID || "";
const mask = (s) => String(s ?? "").replaceAll(OWNER, "<dueño>").replace(/studio-script:[0-9a-f-]{36}:/i, "studio-script:<dueño>:");
const since = new Date(Date.now() - 36 * 3600_000).toISOString();

// 1) Política y estado de la cuota (mismas funciones de solo lectura que usa pi_submit_with_supply).
const { data: pol } = await db.from("pi_supply_policies").select("provider,enabled,max_concurrent,max_daily_calls,daily_cap_usd,monthly_cap_usd,timezone").in("provider", ["anthropic", "heygen", "elevenlabs", "recraft", "__global__"]);
out("POLICY", pol ?? []);
const { data: st } = await db.rpc("pi_supply_state", { p_provider: "anthropic" });
for (const pv of ["heygen", "elevenlabs", "recraft"]) { const { data: ps } = await db.rpc("pi_supply_state", { p_provider: pv }); out(`STATE_${pv.toUpperCase()}`, { level: ps?.level ?? null, todayCalls: ps?.todayCalls ?? null, activeCalls: ps?.activeCalls ?? null }); }
// Episodio de estudio de Base Dulce que falló por «daily request quota» (solo estado y error; sin guion ni dueño).
{ const { data: ep } = await db.from("podcast_studio_episodes").select("id,status,error,updated_at,cost_usd").eq("id", "18989245-eb29-4755-be7f-2cd13655bf1c").maybeSingle(); out("EPISODIO_18989245", ep ? { status: ep.status, error: ep.error, updated_at: ep.updated_at, cost_usd: ep.cost_usd } : null); }
out("ANTHROPIC_STATE", { level: st?.level ?? null, todayCalls: st?.todayCalls ?? null, activeCalls: st?.activeCalls ?? null, dailySpend: st?.dailySpend ?? null });

// 2) Todas las operaciones de Anthropic de las últimas 36 h, por clase de proyecto (quién consumió la cuota).
const { data: ops, error } = await db.from("pi_paid_operations")
  .select("project_id,shot_id,status,reserved_usd,committed_usd,created_at,updated_at,result_ref,attempt_kind,method,model,provider_job_id")
  .eq("provider", "anthropic").gte("created_at", since).order("created_at", { ascending: true });
if (error) { out("ERROR", error.message); process.exit(1); }
const cls = (p) => p.startsWith("studio-script:") ? "studio-script" : p.startsWith("podcast-studio:") ? "podcast-studio(viejo)" : p.startsWith("documentary:") ? "documental" : p.startsWith("podcast-") ? "podcast-episodio" : p === "operator-script" ? "operator-script" : "reel/otro";
const byDay = {};
for (const o of ops) {
  const day = new Date(new Date(o.created_at).getTime() - 5 * 3600_000).toISOString().slice(0, 10); // America/Cancun (UTC-5, sin horario de verano)
  const k = `${day}|${cls(o.project_id)}|${o.status}`; byDay[k] = (byDay[k] ?? 0) + 1;
}
out("ANTHROPIC_POR_DIA_CANCUN", byDay);

// 3) Guion largo: cada paso con su resultado pagado (métricas, sin texto).
const studio = ops.filter((o) => o.project_id.startsWith("studio-script:"));
const jobs = new Map();
for (const o of studio) { const j = o.project_id.split(":")[2]; jobs.set(j, [...(jobs.get(j) ?? []), o]); }
const store = db.storage.from("videos");
const textOf = (r) => (r?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n");
const norm = (t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ ]/g, "").replace(/\s+/g, " ").trim();
const turnsOf = (txt) => txt.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const m = /^([^:]{1,60}):\s*(.+)$/.exec(l); return m ? { who: m[1].trim(), text: m[2].trim() } : null; }).filter(Boolean);
for (const [job, list] of jobs) {
  const seenTurns = []; let planBlocks = null; const steps = [];
  for (const o of list) {
    const step = String(o.shot_id).split(":")[1];
    const row = { step, key: String(o.shot_id).endsWith(":paso") ? "por-paso" : "hash", status: o.status, reservado: Number(o.reserved_usd), cobrado: o.committed_usd == null ? null : Number(o.committed_usd), creado: o.created_at, intento: o.attempt_kind };
    if (o.status === "COMMITTED" && o.result_ref && !String(o.result_ref).startsWith("released") && !String(o.result_ref).startsWith("rejected")) {
      const { data } = await store.download(o.result_ref);
      if (data) {
        let r = null; try { r = JSON.parse(await data.text()); } catch {}
        const txt = textOf(r); row.stop = r?.stop_reason ?? null; row.chars = txt.length; row.tokensSalida = r?.usage?.output_tokens ?? null;
        if (step.startsWith("plan")) {
          try { const j = JSON.parse(txt.replace(/^```\w*|```$/gm, "").trim()); planBlocks = (j.bloques ?? j.segments ?? []).length; row.bloquesEscaleta = planBlocks; } catch { row.bloquesEscaleta = "no-json"; }
        } else {
          const t = turnsOf(txt); row.turnos = t.length;
          const prev = new Set(seenTurns.map((x) => norm(x.text)).filter((x) => x.length >= 40));
          const lastPrev = seenTurns.length ? norm(seenTurns[seenTurns.length - 1].text) : null;
          const reps = t.map((x, i) => ({ i, n: norm(x.text) })).filter((x) => x.n.length >= 40 && prev.has(x.n));
          row.repetidos = reps.map((x) => ({ posicion: x.i, largo: x.n.length, esUltimoTurnoPrevio: x.n === lastPrev, enLosUltimos6: seenTurns.slice(-6).some((y) => norm(y.text) === x.n) }));
          row.ultimaLineaSinPuntuacion = !/[.!?…»"”)\]]\s*$/.test(txt.trim().split("\n").filter(Boolean).at(-1) ?? "");
          // Solo los pasos ACEPTABLES (sin repetidos) alimentan lo «ya escrito» de los siguientes.
          if (!reps.length) seenTurns.push(...t);
        }
      } else row.resultado = "no-encontrado";
    }
    steps.push(row);
  }
  out("TRABAJO", { job, bloquesEscaleta: planBlocks, pasos: steps.length, cobradoUsd: Math.round(steps.reduce((a, s) => a + (s.cobrado ?? 0), 0) * 1e4) / 1e4 });
  for (const s of steps) out("PASO", { job: job.slice(0, 8), ...s });
}
// 4) Reservas abiertas viejas (sin modificar).
const { data: open } = await db.from("pi_paid_operations").select("project_id,status,reserved_usd,created_at").eq("provider", "anthropic").in("status", ["RESERVED", "SUBMITTED", "RECONCILIATION_REQUIRED"]);
out("ABIERTAS", (open ?? []).map((o) => ({ clase: cls(o.project_id), status: o.status, reservado: Number(o.reserved_usd), creado: o.created_at })));
out("FIN", { operaciones36h: ops.length, guionLargo: studio.length, trabajos: jobs.size, proyecto: mask("") });
