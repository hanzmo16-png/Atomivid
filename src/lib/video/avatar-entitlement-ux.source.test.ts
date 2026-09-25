import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Regresión del QA blocker real (2026-09-25, "BETA ACCOUNT BLOCKED BY
 * STARTER ENTITLEMENT"): "Generar video final" quedaba visualmente
 * habilitado para avatar aunque el plan del usuario no incluyera avatar —
 * el POST fallaba recién al pulsar. Este archivo vive fuera de
 * dashboard/review/[id]/ a propósito: `node --test <ruta>` trata "[id]"
 * como una clase de caracteres de glob y un test colocado ahí dentro
 * nunca se ejecuta (mismo motivo documentado en script-route-recovery.test.ts
 * y render-route-cas.test.ts) — fs.readFileSync sí puede leer esa ruta
 * literal sin problema.
 */
const SCRIPT_REVIEW_PATH = path.join(
  __dirname,
  "..",
  "..",
  "app",
  "dashboard",
  "review",
  "[id]",
  "ScriptReview.tsx",
);
const REVIEW_PAGE_PATH = path.join(
  __dirname,
  "..",
  "..",
  "app",
  "dashboard",
  "review",
  "[id]",
  "page.tsx",
);
const REQUEST_CARD_PATH = path.join(__dirname, "..", "..", "components", "video", "RequestCard.tsx");
const REQUEST_VIEW_PATH = path.join(__dirname, "request-view.ts");
const RENDER_WORKFLOW_PATH = path.join(__dirname, "..", "..", "..", ".github", "workflows", "render.yml");

test('[8] review/[id]/page.tsx comprueba el entitlement de avatar server-side (avatarEntitlementPreview) ANTES de renderizar el botón', () => {
  const source = fs.readFileSync(REVIEW_PAGE_PATH, "utf-8");
  assert.match(
    source,
    /import\s*\{\s*avatarEntitlementPreview\s*\}\s*from\s*"@\/lib\/billing\/quota"/,
    "debe reutilizar la misma función de quota.ts, no una copia/estimación propia",
  );
  assert.match(source, /data\.mode === "avatar"/, "solo debe comprobarse para modo avatar — Reel/Long Form no cambian");
  assert.match(
    source,
    /entitlementBlockedReason=\{avatarEntitlementBlockedReason\}/,
    "el resultado debe llegar a ScriptReview como prop",
  );
});

test('[8] ScriptReview.tsx deshabilita "Generar video final" (no solo lo oculta tras el click) cuando entitlementBlockedReason está presente', () => {
  const source = fs.readFileSync(SCRIPT_REVIEW_PATH, "utf-8");
  assert.match(
    source,
    /const entitlementBlocked = Boolean\(entitlementBlockedReason\)/,
    "debe derivar un booleano claro del motivo recibido",
  );
  assert.match(
    source,
    /disabled=\{entitlementBlocked \|\| generating \|\| saving \|\| regeneratingAll\}/,
    'el botón "Generar video final" debe quedar deshabilitado cuando el entitlement está bloqueado, no solo fallar tras pulsarlo',
  );
  assert.match(
    source,
    /if \(entitlementBlocked\) return;/,
    "generateFinalVideo() debe negarse a enviar aunque, por algún bug futuro, el botón llegara a estar clickeable",
  );
});

test('[9] Historial: avatar con audio grabado/subido/TTS-desde-texto muestra "Revisar grabación", no "Revisar guion"', () => {
  const requestCardSource = fs.readFileSync(REQUEST_CARD_PATH, "utf-8");
  assert.match(
    requestCardSource,
    /\{request\.recorded_audio_path \? "Revisar grabación" : "Revisar guion"\}/,
    'el CTA de la tarjeta de Historial debe distinguir por recorded_audio_path, igual que ya distingue review/[id]/page.tsx para el <h1>',
  );

  const requestViewSource = fs.readFileSync(REQUEST_VIEW_PATH, "utf-8");
  assert.match(
    requestViewSource,
    /recorded_audio_path\?:\s*string \| null/,
    "VideoRequestSummary debe exponer recorded_audio_path para que RequestCard pueda decidir el copy correcto",
  );
});

/**
 * Regresión exacta del QA real (2026-09-25, "AVATAR REAL HEYGEN ATTEMPT
 * FAILED"): confirmado leyendo la fila real de producción vía
 * scripts/diagnose-avatar-request.ts — error_message =
 * "El modo avatar no está habilitado (AVATAR_MODE_ENABLED=false)." — el
 * worker general (render.yml, el que procesa CUALQUIER "Generar video
 * final" real, incluido avatar desde que es self-service) tenía esto
 * hardcodeado en 'false' con el comentario "el worker general nunca
 * habilita avatar", una premisa cierta antes de este RC mission y falsa
 * después. avatar_provider_video_job_id nunca se creó — HeyGen nunca fue
 * contactado, costo real: $0.
 */
test('.github/workflows/render.yml: AVATAR_MODE_ENABLED ya NO está hardcodeado en \'false\' — el worker general SÍ procesa avatar de verdad', () => {
  const source = fs.readFileSync(RENDER_WORKFLOW_PATH, "utf-8");
  assert.match(source, /AVATAR_MODE_ENABLED:\s*'true'/, "debe estar en 'true' — el allowlist/entitlement ya se aplicó antes de llegar aquí (actions.ts/render/route.ts)");
  assert.ok(!/AVATAR_MODE_ENABLED:\s*'false'/.test(source), "no debe volver a quedar en 'false'");
});
