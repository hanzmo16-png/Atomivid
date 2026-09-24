/**
 * Mecanismo mínimo para poder correr el Visual Test V2 (3 imágenes de
 * prueba de VIDEO #001) dentro de un runtime server-side de Vercel, donde
 * SÍ existe `process.env.OPENAI_API_KEY` — a diferencia del sandbox de
 * este agente, que nunca tiene acceso a esa variable. Ver
 * HANDOFF-PRODUCTION-V1.md sección 21.
 *
 * Este checkpoint SOLO implementa DRY_RUN/PREFLIGHT: valida todo lo
 * necesario para una generación real futura (autorización, manifest,
 * cost guard, idempotencia, presencia de la API key) sin llamar nunca a
 * OpenAI. No existe ningún código de generación real en este módulo ni
 * en la ruta que lo usa (src/app/api/long-form/visual-test-v2/route.ts)
 * — ver VISUAL_TEST_V2_REAL_MODE_LOCKED más abajo.
 *
 * Reutiliza, sin duplicar:
 *   - assertLongFormAccess (access.ts) para autorización — mismo gate de
 *     beta (LONG_FORM_ENABLED + allowlist por id/email) que ya usa el
 *     resto de Long Form.
 *   - buildVisualTestV2Manifest/shouldGenerate (visual-test-v2.ts) para
 *     los 3 shots aprobados y la idempotencia por archivo en disco.
 *   - assertCanSpend/readCostLedgerFromDisk (video-cost-guard.ts) para el
 *     tope de $0.50 (Visual Test V2) y el hard stop de $3.00 (VIDEO #001).
 */
import {
  buildVisualTestV2Manifest,
  shouldGenerate,
  VISUAL_TEST_V2_MAX_USD,
  type VisualTestV2Manifest,
} from "./visual-test-v2";
import {
  assertCanSpend,
  readCostLedgerFromDisk,
  VIDEO_001_HARD_STOP_USD,
  VideoCostGuardExceededError,
  type CostLedger,
} from "./video-cost-guard";
import { assertLongFormAccess, LongFormDisabledError, LongFormNotAllowlistedError } from "./access";

/** Los 3 shots aprobados por el usuario (sección 14/20 del handoff) — cualquier desviación del manifest real es un bug técnico, nunca un cambio editorial silencioso. */
const EXPECTED_SHOT_IDS = ["b1-s4", "b4-s2", "b8-s5"] as const;

/**
 * Guard de código explícito: en este checkpoint, REAL generation es
 * IMPOSIBLE de disparar desde este mecanismo — no existe ninguna rama de
 * código que llame a OpenAI, sin importar qué credenciales existan en el
 * entorno (incluida OPENAI_API_KEY) ni qué body llegue en el request.
 * Deliberadamente NO es una variable de entorno (una env var mal puesta
 * en Vercel podría encenderla sin querer, igual que advierte mode.ts
 * sobre LONG_FORM_REAL_RUN_CONFIRM) — es una constante de código. Para
 * habilitar REAL mode hace falta un commit nuevo, explícitamente
 * autorizado, que además IMPLEMENTE el código de generación real (que
 * hoy no existe en este módulo).
 */
export const VISUAL_TEST_V2_REAL_MODE_LOCKED = true as const;

export type VisualTestV2RequestBody = { mode: "dry_run" };

export class VisualTestV2InvalidRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VisualTestV2InvalidRequestError";
  }
}

export class VisualTestV2RealModeLockedError extends Error {
  constructor() {
    super(
      "REAL mode de Visual Test V2 está bloqueado en este checkpoint por una constante de código " +
        "(VISUAL_TEST_V2_REAL_MODE_LOCKED), no por una variable de entorno. Ningún valor de " +
        "OPENAI_API_KEY ni ningún body de request puede activarlo — requiere un checkpoint nuevo, " +
        "explícitamente autorizado, que implemente la generación real.",
    );
    this.name = "VisualTestV2RealModeLockedError";
  }
}

/**
 * Valida el body EXACTO permitido: solo `{ mode: "dry_run" }`. Cualquier
 * otra clave (prompt, count, shots, etc.) o cualquier otro valor de
 * `mode` se rechaza — el cliente nunca puede inyectar un prompt
 * arbitrario ni pedir una cantidad de imágenes distinta a las 3 ya
 * aprobadas, porque el endpoint estructuralmente no acepta esos campos.
 */
export function parseVisualTestV2RequestBody(body: unknown): VisualTestV2RequestBody {
  if (typeof body !== "object" || body === null) {
    throw new VisualTestV2InvalidRequestError("Body inválido: se esperaba un objeto JSON.");
  }
  const keys = Object.keys(body as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "mode") {
    throw new VisualTestV2InvalidRequestError(
      'Body inválido: el único campo permitido es "mode". No se aceptan prompts, cantidades ni otros parámetros.',
    );
  }
  const mode = (body as { mode: unknown }).mode;
  if (mode === "real") {
    throw new VisualTestV2RealModeLockedError();
  }
  if (mode !== "dry_run") {
    throw new VisualTestV2InvalidRequestError('Body inválido: "mode" debe ser exactamente "dry_run".');
  }
  return { mode: "dry_run" };
}

/** Manifest inválido = bug técnico, nunca se autogenera nada raro: se rechaza duro en vez de intentar adivinar. */
export function assertValidVisualTestV2Manifest(manifest: Pick<VisualTestV2Manifest, "shots" | "estimatedTotalUsd">): void {
  if (manifest.shots.length > 3) {
    throw new VisualTestV2InvalidRequestError(
      `Manifest inválido: ${manifest.shots.length} shots — Visual Test V2 nunca genera más de 3 imágenes.`,
    );
  }
  const actualIds = manifest.shots.map((s) => s.shotId);
  const expected = [...EXPECTED_SHOT_IDS];
  if (actualIds.length !== expected.length || !expected.every((id, i) => actualIds[i] === id)) {
    throw new VisualTestV2InvalidRequestError(
      `Manifest inválido: se esperaban exactamente los shots ${JSON.stringify(expected)}, se encontraron ${JSON.stringify(actualIds)}.`,
    );
  }
  if (manifest.estimatedTotalUsd > VISUAL_TEST_V2_MAX_USD) {
    throw new VisualTestV2InvalidRequestError(
      `Manifest inválido: costo estimado $${manifest.estimatedTotalUsd} supera el tope de Visual Test V2 ($${VISUAL_TEST_V2_MAX_USD}).`,
    );
  }
}

export type VisualTestV2PreflightShotReport = {
  shotId: string;
  idempotencyKey: string;
  outputPath: string;
  estimatedCostUsd: number;
  wouldGenerate: boolean;
};

export type VisualTestV2PreflightReport = {
  mode: "dry_run";
  videoId: string;
  openaiApiKeyAvailable: boolean;
  manifestValid: true;
  shots: VisualTestV2PreflightShotReport[];
  estimatedTotalUsd: number;
  maxTotalUsd: number;
  hardStopUsd: number;
  alreadySpentVisualTestV2Usd: number;
  alreadySpentTotalUsd: number;
  withinCostGuard: boolean;
  costGuardBlockReason?: string;
  realModeLocked: true;
  paidApisCalled: false;
};

export type VisualTestV2PreflightOptions = {
  env?: Record<string, string | undefined>;
  /** Solo para tests — override del outputDir del manifest (para no tocar content/ real). */
  outputDir?: string;
  /** Solo para tests — override de la ruta del cost ledger (para no tocar .atomivid-state/ real). */
  ledgerPath?: string;
};

/**
 * Preflight puro salvo lectura de disco/env (nunca escritura, nunca red)
 * — ejecuta exactamente las validaciones pedidas ANTES de autorizar
 * cualquier llamada paga futura. No genera nada, no gasta nada, no
 * confirma ningún gasto en el ledger — por eso es seguro llamarlo
 * repetidas veces (ver visual-test-v2-runtime.test.ts, escenario de
 * "duplicate/idempotent request").
 */
export function runVisualTestV2Preflight(options: VisualTestV2PreflightOptions = {}): VisualTestV2PreflightReport {
  const env = options.env ?? process.env;

  const manifest = buildVisualTestV2Manifest(options.outputDir);
  assertValidVisualTestV2Manifest(manifest);

  const ledger: CostLedger = readCostLedgerFromDisk(manifest.videoId, options.ledgerPath);
  let withinCostGuard = true;
  let costGuardBlockReason: string | undefined;
  try {
    assertCanSpend(ledger, "visual_test_v2", manifest.estimatedTotalUsd);
  } catch (error) {
    if (error instanceof VideoCostGuardExceededError) {
      withinCostGuard = false;
      costGuardBlockReason = error.message;
    } else {
      throw error;
    }
  }

  const shots: VisualTestV2PreflightShotReport[] = manifest.shots.map((s) => ({
    shotId: s.shotId,
    idempotencyKey: s.idempotencyKey,
    outputPath: s.outputPath,
    estimatedCostUsd: s.estimatedCostUsd,
    wouldGenerate: shouldGenerate(s),
  }));

  const alreadySpentVisualTestV2Usd = round4(
    ledger.entries.filter((e) => e.category === "visual_test_v2").reduce((sum, e) => sum + e.amountUsd, 0),
  );
  const alreadySpentTotalUsd = round4(ledger.entries.reduce((sum, e) => sum + e.amountUsd, 0));

  return {
    mode: "dry_run",
    videoId: manifest.videoId,
    openaiApiKeyAvailable: Boolean(env.OPENAI_API_KEY),
    manifestValid: true,
    shots,
    estimatedTotalUsd: manifest.estimatedTotalUsd,
    maxTotalUsd: VISUAL_TEST_V2_MAX_USD,
    hardStopUsd: VIDEO_001_HARD_STOP_USD,
    alreadySpentVisualTestV2Usd,
    alreadySpentTotalUsd,
    withinCostGuard,
    ...(costGuardBlockReason ? { costGuardBlockReason } : {}),
    realModeLocked: VISUAL_TEST_V2_REAL_MODE_LOCKED,
    paidApisCalled: false,
  };
}

export type VisualTestV2AuthUser = { id?: string | null; email?: string | null } | null | undefined;

export type VisualTestV2RouteResult = { status: number; body: Record<string, unknown> };

/**
 * Toda la decisión de la ruta HTTP, extraída a una función pura para
 * poder probarla sin Next.js ni Supabase — mismo patrón que
 * evaluateRenderStart en render-guard.ts. La ruta real
 * (src/app/api/long-form/visual-test-v2/route.ts) es solo el adaptador:
 * obtiene `user` de Supabase y el body del Request, y delega aquí.
 */
export function evaluateVisualTestV2Request(
  user: VisualTestV2AuthUser,
  rawBody: unknown,
  options: VisualTestV2PreflightOptions = {},
): VisualTestV2RouteResult {
  if (!user) {
    return { status: 401, body: { error: "No autenticado" } };
  }

  try {
    assertLongFormAccess(user, options.env ?? process.env);
  } catch (error) {
    if (error instanceof LongFormDisabledError || error instanceof LongFormNotAllowlistedError) {
      return { status: 403, body: { error: "No autorizado" } };
    }
    throw error;
  }

  try {
    parseVisualTestV2RequestBody(rawBody);
  } catch (error) {
    if (error instanceof VisualTestV2RealModeLockedError) {
      return { status: 403, body: { error: error.message } };
    }
    if (error instanceof VisualTestV2InvalidRequestError) {
      return { status: 400, body: { error: error.message } };
    }
    throw error;
  }

  const report = runVisualTestV2Preflight(options);
  return { status: 200, body: report };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
