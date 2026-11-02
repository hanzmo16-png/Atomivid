// USD 0, SOLO LECTURA: vuelve a pasar las respuestas YA PAGADAS del guion largo (libro real + resultados guardados) por el
// motor de dos versiones del código (la desplegada y la corregida) para saber, sin llamar a la IA, POR QUÉ se rechazó cada
// bloque y qué haría la corrección. No imprime textos: solo pasos, veredictos, motivos (sin contenido) y conteos.
// Uso: REPLAY_ROOTS="desplegado=/ruta/a/worktree,corregido=/ruta/a/worktree" node pod-replay.mjs
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const out = (k, v) => console.log(`${k} ${JSON.stringify(v)}`);
const roots = (process.env.REPLAY_ROOTS || "").split(",").filter(Boolean).map((x) => x.split("="));
const since = new Date(Date.now() - 48 * 3600_000).toISOString();
const { data: ops } = await db.from("pi_paid_operations").select("project_id,shot_id,status,result_ref,created_at")
  .eq("provider", "anthropic").like("project_id", "studio-script:%").gte("created_at", since).order("created_at", { ascending: true });
const store = db.storage.from("videos");
const textOf = (r) => (r?.content ?? []).filter((c) => c?.type === "text").map((c) => c.text ?? "").join("\n");
const jobs = new Map();
for (const o of ops ?? []) {
  const job = o.project_id.split(":")[2], step = String(o.shot_id).split(":")[1];
  const j = jobs.get(job) ?? new Map(); jobs.set(job, j);
  if (o.status !== "COMMITTED" || !o.result_ref) continue;
  const { data } = await store.download(o.result_ref); if (!data) continue;
  let r = null; try { r = JSON.parse(await data.text()); } catch {}
  if (r) j.set(step, { text: textOf(r), stopReason: r.stop_reason ?? null });
}
// Nombres de los participantes: las dos etiquetas «Nombre:» más frecuentes del primer bloque, en orden de aparición.
const names = (txt) => { const c = new Map(); for (const l of txt.split("\n")) { const m = /^([^:]{1,60}):\s*\S/.exec(l.trim()); if (m) c.set(m[1].trim(), (c.get(m[1].trim()) ?? 0) + 1); } return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map((x) => x[0]); };
// Etiquetas de hablante de cada paso pagado, enmascaradas (L1, L2…): cuántas distintas y si alguna es variante de otra
// (p. ej. «Hans» frente a «El Duro Hans»). Sin nombres ni texto.
for (const [job, steps] of jobs) for (const [step, r] of steps) {
  if (step.startsWith("plan")) continue;
  const c = new Map(); for (const l of r.text.split("\n")) { const m = /^([^:]{1,60}):\s*\S/.exec(l.trim()); if (m) c.set(m[1].trim(), (c.get(m[1].trim()) ?? 0) + 1); }
  const labs = [...c.entries()].sort((a, b) => b[1] - a[1]);
  const variant = labs.some(([a], i) => labs.some(([b], j) => i !== j && (b.toLowerCase().includes(a.toLowerCase()))));
  out("ETIQUETAS", { job: job.slice(0, 8), step, distintas: labs.length, conteos: labs.map(([, n], i) => `L${i + 1}:${n}`), variante: variant });
}
for (const [label, root] of roots) {
  const L = await import(pathToFileURL(`${root}/src/lib/podcast/v3/long-script.ts`).href);
  for (const [job, steps] of jobs) {
    const plan = steps.get("plan-a1"); const s0 = [...steps.entries()].find(([k]) => k.startsWith("s0-"));
    if (!plan || !s0) { out("REPLAY", { version: label, job: job.slice(0, 8), estado: "sin escaleta o sin bloque 1 pagado" }); continue; }
    let n = 0; try { const pj = JSON.parse(plan.text.replace(/^```\w*|```$/gm, "").trim()); n = (pj.bloques ?? pj.segments ?? []).length; } catch {}
    const minutes = n >= 5 ? 44 : 30;
    const [host, guest] = names(s0[1].text);
    const input = L.normalizeLongInput({ topic: "BASE DULCE (reconstrucción)", minutes, hostName: host, guestName: guest });
    let st = L.newLongScript(job, input); const trace = []; const missing = { step: null };
    const llm = async (_prompt, o) => { const r = steps.get(o.step); if (!r) { missing.step = o.step; throw new Error("PENDIENTE"); } return r; };
    const replay = async (step) => steps.get(step) ?? null;
    for (let i = 0; i < 40; i++) {
      try {
        const r = await L.advanceLongScript(st, llm, replay);
        trace.push({ paso: r.phase, bloquesGuardados: r.state.segments.length, nota: r.note ? r.note.replace(/\d{3,}/g, "#") : undefined });
        st = r.state; if (r.done) { trace.push({ fin: true }); break; }
      } catch (e) {
        if (e?.message === "PENDIENTE") { trace.push({ pendiente: missing.step }); break; }
        if (e?.code) { trace.push({ rechazo: e.code, motivo: String(e.message).replace(/\(([^)]*)\)/, (m) => m).slice(0, 220) }); if (e.state) st = e.state; if (e.code !== "INVALIDO") break; continue; }
        trace.push({ error: String(e?.message ?? e).slice(0, 160) }); break;
      }
    }
    out("REPLAY", { version: label, job: job.slice(0, 8), bloques: n, minutos: minutes, pagados: [...steps.keys()], recorrido: trace, bloquesFinales: st.segments.length, intentos: st.attempts });
  }
}
