// Ensayo LF: persiste un guion YA APROBADO por el flujo editorial real (editorial-chain.ts) con las RPC productivas
// claim/finish_documentary_script_job, igual que runScriptJobStep. Comprueba antes la misma puerta que confirm-production.
import fs from "node:fs"; import { randomUUID } from "node:crypto"; import pg from "pg";
import { editorialApprovalError } from "@/lib/video/long-form/editorial";
const script = JSON.parse(fs.readFileSync(process.env.APPROVED_SCRIPT!, "utf8"));
const gate = editorialApprovalError(script); console.log("editorialApprovalError:", gate ?? "null (aprobado)"); if (gate) process.exit(1);
(async () => { const c = new pg.Client({ connectionString: `postgres://postgres@localhost:${process.env.PGPORT ?? 55432}/atomivid?host=${process.env.E2E_HOME}/run` }); await c.connect();
  const tok = randomUUID(), id = process.env.JOB_ID!;
  console.log("claim", JSON.stringify((await c.query("select public.claim_documentary_script_job($1,$2) as r", [id, tok])).rows[0].r));
  await c.query("select public.finish_documentary_script_job($1,$2,$3)", [id, tok, JSON.stringify({ ...script, topic: process.env.TOPIC ?? script.topic })]);
  const r = (await c.query("select j.status, v.status vstatus, v.duration_seconds, v.aspect_ratio, jsonb_array_length(v.script_json->'beats') n, v.script_json->'editorial'->>'version' ev from documentary_script_jobs j join video_requests v on v.id=j.request_id where j.id=$1", [id])).rows[0];
  console.log("video_request", JSON.stringify(r)); await c.end(); })().catch(e => { console.error(e); process.exit(1); });
