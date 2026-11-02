/**
 * T-20261102-1023 (Base Dulce, episodio 18989245, 2026-11-02 14:43Z): el estudio se bloqueó ANTES de cobrar con
 * «HeyGen (avatar): alcanzó su cuota diaria de llamadas». Causa: límite PROPIO de ATOMIVID (pi_supply_policies.
 * max_daily_calls de heygen, comprobado por ensureJobSupplyReady), NO un 429 de HeyGen: el episodio necesitaba 45 clips.
 * Y el asistente mostraba a la vez «No se pudo terminar» y «el episodio sigue generándose».
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readinessMessage } from "./readiness";
import { episodeInProgress } from "../../../app/dashboard/podcast/PodcastWizard";

test("cuota diaria de HeyGen: con los números, el mensaje dice si esperar sirve o no", () => {
  const structural = readinessMessage({ provider: "heygen", reason: "daily request quota", quota: { max: 20, today: 0, calls: 45, timezone: "America/Cancun" } });
  assert.match(structural, /^HeyGen \(avatar\): este episodio necesita 45 llamadas y el límite diario de la plataforma es 20; no cabe en un día aunque se espere\./);
  assert.match(structural, /Reduce las apariciones del avatar/); assert.doesNotMatch(structural, /se restablece/);
  const today = readinessMessage({ provider: "heygen", reason: "daily request quota", quota: { max: 60, today: 30, calls: 45, timezone: "America/Cancun" } });
  assert.equal(today, "HeyGen (avatar): hoy ya se usaron 30 de las 60 llamadas diarias de la plataforma y este episodio necesita 45; el límite se restablece a las 00:00 hora de Cancún.");
  // Sin números (versiones anteriores del control) el texto de siempre.
  assert.equal(readinessMessage({ provider: "heygen", reason: "daily request quota" }), "HeyGen (avatar): alcanzó su cuota diaria de llamadas.");
});

test("estado único: solo «authorized» y «generating» siguen en curso; «failed» y «ready» no dicen «sigue generándose»", () => {
  for (const s of ["authorized", "generating"]) assert.equal(episodeInProgress(s), true, s);
  for (const s of ["failed", "ready", "draft", undefined, null]) assert.equal(episodeInProgress(s), false, String(s));
  const wiz = readFileSync(path.join(__dirname, "../../../app/dashboard/podcast/PodcastWizard.tsx"), "utf8");
  assert.match(wiz, /\{episodeInProgress\(cur\?\.episode\.status\) && <p[^>]*data-testid="wizard-sigue-generando">Puedes cerrar esta página: el episodio sigue generándose/);
  assert.doesNotMatch(wiz, /cur\?\.episode\.status !== "ready" && <p[^>]*>Puedes cerrar esta página/);
});

test("el worker del estudio pasa los números de la cuota al mensaje (sin llamadas al proveedor: se decide antes de cobrar)", () => {
  const worker = readFileSync(path.join(__dirname, "../../../../scripts/podcast-3-0/studio-worker.ts"), "utf8");
  assert.match(worker, /return r\.ready \? null : readinessMessage\(r\.failure\);/);
  const supply = readFileSync(path.join(__dirname, "../../supply/readiness.ts"), "utf8");
  assert.match(supply, /row\.failure = "daily request quota"; row\.quota = \{ max, today, calls: d\.calls/);
});

test("el error que ve la persona: motivo con números + «No se hizo ningún cargo» (ProviderNotReadyError)", async () => {
  const { ProviderNotReadyError } = await import("./pipeline");
  const e = new ProviderNotReadyError(readinessMessage({ provider: "heygen", reason: "daily request quota", quota: { max: 20, today: 0, calls: 45, timezone: "America/Cancun" } }));
  assert.match(e.message, /^Proveedor no listo: HeyGen \(avatar\): este episodio necesita 45 llamadas.*No se hizo ningún cargo\.$/);
  // Cero llamadas de pago cuando la verificación previa bloquea: render.test.ts «barreras previas» y «cuota diaria de
  // llamadas» (MemoryLedger vacío, sin llamadas a voz ni avatar).
});
