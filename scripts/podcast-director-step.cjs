#!/usr/bin/env node
// Child step of the podcast worker for PODCAST_MONTAGE_ENGINE=director (see src/lib/podcast/montage-engine.ts).
// Runs INSIDE the Director's isolation (scripts/ejecutar_aislado.sh): loads the existing worker adapter of the built
// Director package and calls materializeForWorker once. Lookups come only from the request (measured dimensions,
// recorded rights); nothing is inferred. Prints one JSON line: {status:"ready",manifestSha256} | {status:"blocked"|"error",blockers}.
// Exit: 0 ready, 2 blocked, 1 error. Usage: node podcast-director-step.cjs <PODCAST_DIRECTOR_DIR> <request.json>
// --probe <PODCAST_DIRECTOR_DIR> <probe dir>: the worker's free pre-check of the SAME isolated launch, before any paid step.
// Writes nothing outside <probe dir>. {status:"probe-ok",checks} exit 0 | {status:"probe-failed",failed,checks} exit 3.
"use strict";
const fs = require("fs"), path = require("path");
const out = (code, v) => { process.stdout.write(JSON.stringify(v) + "\n"); process.exitCode = code; };
const fail = (code, message) => out(1, { status: "error", blockers: [{ code, message }] });
function probe(dir, probeDir) {
  const checks = [], failed = [];
  const check = (name, fn) => { let ok = false; try { ok = fn() === true; } catch { ok = false; } (ok ? checks : failed).push(name); };
  check("rutas_absolutas", () => path.isAbsolute(dir) && path.isAbsolute(probeDir));
  check("adaptador_legible", () => { const a = require(path.join(dir, "dist/adaptador/worker-adapter.js")); return typeof a.materializeForWorker === "function" && typeof a.toDirectorInput === "function"; });
  check("proc_self_fd", () => fs.readdirSync("/proc/self/fd").length > 0);
  check("escritura_en_trabajo", () => {
    const f = path.join(probeDir, `.sonda-${process.pid}`);
    fs.writeFileSync(f, "ok", { flag: "wx" }); const back = fs.readFileSync(f, "utf8"); fs.unlinkSync(f); return back === "ok";
  });
  check("solo_lectura_fuera_del_trabajo", () => {
    const f = path.join(dir, `.sonda-${process.pid}`);
    try { fs.writeFileSync(f, "x", { flag: "wx" }); } catch (e) { return ["EROFS", "EACCES", "EPERM"].includes(e && e.code); }
    try { fs.unlinkSync(f); } catch { /* best effort */ }
    return false;
  });
  out(failed.length ? 3 : 0, failed.length ? { status: "probe-failed", failed, checks } : { status: "probe-ok", checks });
}

try {
  if (process.argv[2] === "--probe") return probe(String(process.argv[3] || ""), String(process.argv[4] || ""));
  const [dir, reqPath] = process.argv.slice(2);
  if (!dir || !reqPath || !path.isAbsolute(dir)) return fail("DIRECTOR_ENV_MISSING", "uso: podcast-director-step.cjs <dir absoluto> <request.json>");
  let req;
  try { req = JSON.parse(fs.readFileSync(reqPath, "utf8")); } catch { return fail("DIRECTOR_REQUEST_INVALID", "solicitud ilegible"); }
  if (!req || req.schema !== "atomivid/podcast-director-step@1" || !req.worker || typeof req.worker.inputDir !== "string") return fail("DIRECTOR_REQUEST_INVALID", "solicitud con forma inesperada");
  let adapter;
  try { adapter = require(path.join(dir, "dist/adaptador/worker-adapter.js")); } catch { return fail("DIRECTOR_MODULE_MISSING", "no se pudo cargar dist/adaptador/worker-adapter.js"); }
  if (typeof adapter.materializeForWorker !== "function") return fail("DIRECTOR_MODULE_MISSING", "el adaptador no exporta materializeForWorker");
  const w = req.worker, rel = (f) => path.relative(w.inputDir, f);
  const own = (o, k) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null);
  const r = adapter.materializeForWorker(w, {
    dimensions: (f) => own(req.dimensions, rel(f)),
    rightsBasis: (f) => own(req.rights, rel(f)),
    requireAvatarSegments: Array.isArray(req.requireAvatarSegments) ? req.requireAvatarSegments : [],
    avatar: null,
    sampleRate: w.sampleRate,
  });
  if (r && r.status === "ready") return out(0, { status: "ready", manifestSha256: r.manifestSha256 });
  const blockers = (r && Array.isArray(r.blockers) ? r.blockers : []).map((b) => ({ code: String(b.code), message: String(b.message ?? "").slice(0, 300) }));
  out(2, { status: "blocked", blockers: blockers.length ? blockers : [{ code: "DIRECTOR_BLOCKED", message: "bloqueado sin detalle" }] });
} catch (e) {
  fail("DIRECTOR_INTERNAL", String((e && e.message) || e).slice(0, 200));
}
