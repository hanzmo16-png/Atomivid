/**
 * Autorización de gasto SOLO para el Visual Test V2 (herramienta interna).
 *
 * No toca el flujo de creación de Long Form / YouTube, ni `assertLongFormAccess`,
 * ni `pi_spend_authorizations` (eso es infra compartida de podcast/documental y
 * exigiría una migración). Un string público de confirmación no es una
 * autorización (incidente PR #194): aquí el servidor exige
 *   1. sesión de owner/admin (`isCommandCenterAdmin`, configuración vacía = nadie), y
 *   2. un token HMAC de corta vida, atado al user id y al tope de US$0.50.
 * Sin las dos cosas, `runVisualTestV2RealGeneration` no llega a llamarse.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isCommandCenterAdmin, type AuthUser } from "@/lib/command-center/access";
import { VISUAL_TEST_V2_MAX_USD } from "./video-cost-guard";
import { VISUAL_TEST_V2_REAL_CONFIRM_VALUE } from "./visual-test-v2-real-confirm";

export const VISUAL_TEST_V2_SPEND_AUTH_TTL_MS = 10 * 60 * 1000;
const CLOCK_SKEW_MS = 60 * 1000;
const KIND = "visual-test-v2-spend-authorization" as const;
const PURPOSE = "atomivid:visual-test-v2-spend:v1";

export type VerifiedVisualTestV2SpendAuthorization = {
  readonly kind: typeof KIND;
  readonly userId: string;
  readonly maxUsd: number;
};

export class VisualTestV2SpendAuthorizationError extends Error {
  constructor() {
    super("Visual Test V2 REAL: falta una autorización de gasto válida. No se llama al proveedor.");
    this.name = "VisualTestV2SpendAuthorizationError";
  }
}

export type VisualTestV2Actor = {
  id?: string | null;
  email?: string | null;
  email_confirmed_at?: string | null;
} | null | undefined;

type TokenPayload = {
  v: 1;
  uid: string;
  maxUsd: number;
  exp: number;
  nonce: string;
};

function asAdminUser(user: VisualTestV2Actor): AuthUser {
  if (!user) return null;
  return {
    id: user.id ?? undefined,
    email: user.email ?? undefined,
    email_confirmed_at: user.email_confirmed_at ?? undefined,
  };
}

function safeEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Clave de firma. Preferimos un secreto dedicado si ya existe; si no, derivamos
 * una clave de `SUPABASE_SERVICE_ROLE_KEY` (ya presente en el runtime) sin
 * copiarla al token. Sin ninguna de las dos, el gasto queda cerrado.
 * Esta función no se llama desde el cliente.
 */
export function visualTestV2SpendAuthSecret(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const dedicated = env.VISUAL_TEST_V2_SPEND_AUTH_SECRET?.trim();
  if (dedicated && dedicated.length >= 16) return dedicated;
  const service = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!service) return null;
  return createHash("sha256").update(`${PURPOSE}\n${service}`).digest("hex");
}

export function issueVisualTestV2SpendAuthorization(input: {
  userId: string;
  secret: string;
  nowMs?: number;
  nonce?: string;
}): { token: string; maxUsd: number; expiresAtMs: number } | null {
  const userId = input.userId.trim();
  if (!userId || !input.secret) return null;
  const nowMs = input.nowMs ?? Date.now();
  const payload: TokenPayload = {
    v: 1,
    uid: userId,
    maxUsd: VISUAL_TEST_V2_MAX_USD,
    exp: nowMs + VISUAL_TEST_V2_SPEND_AUTH_TTL_MS,
    nonce: input.nonce ?? randomBytes(16).toString("hex"),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", input.secret).update(body).digest("base64url");
  return { token: `${body}.${sig}`, maxUsd: VISUAL_TEST_V2_MAX_USD, expiresAtMs: payload.exp };
}

export function verifyVisualTestV2SpendAuthorization(
  token: string,
  userId: string,
  nowMs: number,
  secret: string,
): VerifiedVisualTestV2SpendAuthorization | null {
  if (!secret || !userId || token === VISUAL_TEST_V2_REAL_CONFIRM_VALUE) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(sig, expected)) return null;
  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
  } catch {
    return null;
  }
  if (payload.v !== 1) return null;
  if (payload.uid !== userId) return null;
  if (payload.maxUsd !== VISUAL_TEST_V2_MAX_USD) return null;
  if (typeof payload.nonce !== "string" || payload.nonce.length < 8) return null;
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) return null;
  if (nowMs >= payload.exp) return null;
  if (payload.exp - nowMs > VISUAL_TEST_V2_SPEND_AUTH_TTL_MS + CLOCK_SKEW_MS) return null;
  return { kind: KIND, userId: payload.uid, maxUsd: payload.maxUsd };
}

export function assertVisualTestV2SpendAuthorization(
  authorization: VerifiedVisualTestV2SpendAuthorization | undefined,
): asserts authorization is VerifiedVisualTestV2SpendAuthorization {
  if (
    !authorization ||
    authorization.kind !== KIND ||
    authorization.maxUsd !== VISUAL_TEST_V2_MAX_USD ||
    typeof authorization.userId !== "string" ||
    authorization.userId.length === 0
  ) {
    throw new VisualTestV2SpendAuthorizationError();
  }
}

const UNAUTHORIZED = "No autorizado";
const MISSING_SPEND_AUTH = "Autorización de gasto inválida o ausente.";
const BAD_BODY = "Body inválido: se requiere exactamente una autorización de gasto.";

export type VisualTestV2RealDecision =
  | { ok: false; status: number; body: { error: string } }
  | { ok: true; authorization: VerifiedVisualTestV2SpendAuthorization };

export function evaluateVisualTestV2RealRequest(
  user: VisualTestV2Actor,
  rawBody: unknown,
  options: {
    env?: Record<string, string | undefined>;
    nowMs?: number;
    secret?: string | null;
  } = {},
): VisualTestV2RealDecision {
  if (!user) return { ok: false, status: 401, body: { error: "No autenticado" } };

  const env = options.env ?? process.env;
  if (!isCommandCenterAdmin(asAdminUser(user), env)) {
    return { ok: false, status: 403, body: { error: UNAUTHORIZED } };
  }

  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    return { ok: false, status: 400, body: { error: BAD_BODY } };
  }
  const keys = Object.keys(rawBody as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "confirm") {
    return { ok: false, status: 400, body: { error: BAD_BODY } };
  }
  const confirm = (rawBody as { confirm: unknown }).confirm;
  if (typeof confirm !== "string" || confirm.length === 0 || confirm === VISUAL_TEST_V2_REAL_CONFIRM_VALUE) {
    return { ok: false, status: 403, body: { error: MISSING_SPEND_AUTH } };
  }

  const userId = user.id?.trim();
  const secret = options.secret !== undefined ? options.secret : visualTestV2SpendAuthSecret(env);
  if (!userId || !secret) return { ok: false, status: 403, body: { error: MISSING_SPEND_AUTH } };

  const authorization = verifyVisualTestV2SpendAuthorization(confirm, userId, options.nowMs ?? Date.now(), secret);
  if (!authorization) return { ok: false, status: 403, body: { error: MISSING_SPEND_AUTH } };
  return { ok: true, authorization };
}
