#!/usr/bin/env node
// Child step of the podcast worker for PODCAST_MONTAGE_ENGINE=director (see src/lib/podcast/montage-engine.ts).
// Runs INSIDE the Director's isolation (scripts/ejecutar_aislado.sh): loads the existing worker adapter of the built
// Director package and calls materializeForWorker once. Lookups come only from the request (measured dimensions,
// recorded rights); nothing is inferred. Prints one JSON line: {status:"ready",manifestSha256} | {status:"blocked"|"error",blockers}.
// Exit: 0 ready, 2 blocked, 1 error. Usage: node podcast-director-step.cjs <PODCAST_DIRECTOR_DIR> <request.json>
"use strict";
const fs = require("fs"), path = require("path");
const out = (code, v) => { process.stdout.write(JSON.stringify(v) + "\n"); process.exitCode = code; };
const fail = (code, message) => out(1, { status: "error", blockers: [{ code, message }] });
try {
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
