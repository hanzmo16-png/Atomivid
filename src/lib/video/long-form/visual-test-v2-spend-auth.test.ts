import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isCommandCenterAdmin } from "@/lib/command-center/access";
import type { ImageProvider, ImageGenerationRequest, GenerativeAsset } from "@/lib/providers/types";
import { VISUAL_TEST_V2_REAL_CONFIRM_VALUE } from "./visual-test-v2-real-confirm";
import { runVisualTestV2RealGeneration } from "./visual-test-v2-real";
import { writeVisualTestV2Ledger } from "./visual-test-v2-storage";
import { emptyLedger, recordSpend, VideoCostGuardExceededError, VISUAL_TEST_V2_MAX_USD } from "./video-cost-guard";
import {
  evaluateVisualTestV2RealRequest,
  issueVisualTestV2SpendAuthorization,
  verifyVisualTestV2SpendAuthorization,
  visualTestV2SpendAuthSecret,
  VisualTestV2SpendAuthorizationError,
  VISUAL_TEST_V2_SPEND_AUTH_TTL_MS,
} from "./visual-test-v2-spend-auth";

/**
 * H01: la generación real del Visual Test V2 se prueba solo con un proveedor
 * simulado. Ningún test de este archivo llama a OpenAI, fal, Recraft, HeyGen ni D-ID.
 */
const SECRET = "visual-test-v2-test-secret";
const NOW = 1_730_000_000_000;
const BUCKET = "videos";
const VIDEO_ID = "gobekli-tepe-001";

const ENV = {
  COMMAND_CENTER_ADMIN_EMAILS: "admin@atomivid.test",
  LONG_FORM_ENABLED: "true",
  LONG_FORM_ALLOWLIST_EMAILS: "beta@atomivid.test,admin@atomivid.test",
  LONG_FORM_ALLOWLIST_USER_IDS: "beta-1,admin-1",
};

const ADMIN = {
  id: "admin-1",
  email: "admin@atomivid.test",
  email_confirmed_at: "2026-01-01T00:00:00.000Z",
};

const BETA = {
  id: "beta-1",
  email: "beta@atomivid.test",
  email_confirmed_at: "2026-01-01T00:00:00.000Z",
};

function tokenFor(userId: string, nowMs = NOW): string {
  const issued = issueVisualTestV2SpendAuthorization({ userId, nowMs, secret: SECRET });
  assert.ok(issued, "el emisor de prueba debe devolver un token");
  assert.equal(issued.maxUsd, 0.5);
  assert.equal(issued.token.includes(SECRET), false);
  return issued.token;
}

function makeFakeSupabase() {
  const files = new Map<string, Buffer>();
  const fake = {
    storage: {
      from() {
        return {
          async download(path: string) {
            const buf = files.get(path);
            if (!buf) return { data: null, error: { message: "not found" } };
            return {
              data: {
                async text() {
                  return buf.toString("utf8");
                },
                async arrayBuffer() {
                  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
                },
              },
              error: null,
            };
          },
          async upload(path: string, body: Buffer) {
            files.set(path, Buffer.from(body));
            return { error: null };
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { fake, files };
}

function fakePngBuffer(tag: string): Buffer {
  const buf = Buffer.alloc(80, 0);
  buf[0] = 0x89;
  buf.write("PNG", 1, "ascii");
  buf.write(tag, 40, "ascii");
  return buf;
}

function makeCountingImageProvider() {
  let callCount = 0;
  const provider: ImageProvider = {
    name: "openai",
    capabilities: {
      id: "openai",
      models: ["gpt-image-2"],
      formats: ["image/png"],
      aspectRatios: ["landscape 3:2"],
      timeoutMs: 1000,
      maxRetries: 0,
    },
    isAvailable() {
      return true;
    },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async generateImage(_request: ImageGenerationRequest): Promise<GenerativeAsset> {
      callCount += 1;
      return {
        buffer: fakePngBuffer(`call-${callCount}`),
        mimeType: "image/png",
        extension: "png",
        width: 1536,
        height: 1024,
        model: "gpt-image-2",
        costUsd: 0.05,
      };
    },
  };
  return { provider, getCallCount: () => callCount };
}

async function attemptPaid(user: typeof ADMIN | typeof BETA | null, body: unknown) {
  const { fake } = makeFakeSupabase();
  const { provider, getCallCount } = makeCountingImageProvider();
  const decision = evaluateVisualTestV2RealRequest(user, body, { env: ENV, nowMs: NOW, secret: SECRET });
  if (!decision.ok) return { status: decision.status, calls: getCallCount(), error: decision.body.error };
  const result = await runVisualTestV2RealGeneration(fake, decision.authorization, {
    bucket: BUCKET,
    imageProvider: provider,
  });
  return { status: 200, calls: getCallCount(), result, authorization: decision.authorization };
}

test("el tope que la UI debe mostrar sigue siendo US$0.50", () => {
  assert.equal(VISUAL_TEST_V2_MAX_USD, 0.5);
});

test("sin clave de firma el gasto queda cerrado; la derivación no copia la service role key", () => {
  assert.equal(visualTestV2SpendAuthSecret({}), null);
  const key = "service-role-test-key-not-real";
  const derived = visualTestV2SpendAuthSecret({ SUPABASE_SERVICE_ROLE_KEY: key });
  assert.ok(derived);
  assert.equal(derived.includes(key), false);
  assert.notEqual(derived, key);
});

test("negativo: anónimo → 401 y el proveedor simulado no se llama", async () => {
  const outcome = await attemptPaid(null, { confirm: tokenFor(ADMIN.id) });
  assert.equal(outcome.status, 401);
  assert.equal(outcome.calls, 0);
});

test("negativo: usuario allowlisted de Long Form que no es admin → 403 aunque mande el confirm público o un token firmado para sí", async () => {
  const withPublicConfirm = await attemptPaid(BETA, { confirm: VISUAL_TEST_V2_REAL_CONFIRM_VALUE });
  assert.equal(withPublicConfirm.status, 403);
  assert.equal(withPublicConfirm.calls, 0);

  const withOwnToken = await attemptPaid(BETA, { confirm: tokenFor(BETA.id) });
  assert.equal(withOwnToken.status, 403);
  assert.equal(withOwnToken.calls, 0);
});

test("negativo: admin sin body de autorización (400), o con el string público, un token ajeno, caducado o alterado (403) — cero llamadas", async () => {
  const missing = await attemptPaid(ADMIN, {});
  assert.equal(missing.status, 400);
  assert.equal(missing.calls, 0);

  const nullBody = await attemptPaid(ADMIN, null);
  assert.equal(nullBody.status, 400);
  assert.equal(nullBody.calls, 0);

  const publicConfirm = await attemptPaid(ADMIN, { confirm: VISUAL_TEST_V2_REAL_CONFIRM_VALUE });
  assert.equal(publicConfirm.status, 403);
  assert.equal(publicConfirm.calls, 0);

  const foreign = await attemptPaid(ADMIN, { confirm: tokenFor(BETA.id) });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.calls, 0);

  const expired = await attemptPaid(ADMIN, { confirm: tokenFor(ADMIN.id, NOW - VISUAL_TEST_V2_SPEND_AUTH_TTL_MS - 5_000) });
  assert.equal(expired.status, 403);
  assert.equal(expired.calls, 0);

  const valid = tokenFor(ADMIN.id);
  const tampered = `${valid.slice(0, -1)}${valid.endsWith("a") ? "b" : "a"}`;
  const altered = await attemptPaid(ADMIN, { confirm: tampered });
  assert.equal(altered.status, 403);
  assert.equal(altered.calls, 0);
});

test("negativo: admin con token válido pero sin secreto de servidor → 403", async () => {
  const decision = evaluateVisualTestV2RealRequest(ADMIN, { confirm: tokenFor(ADMIN.id) }, {
    env: ENV,
    nowMs: NOW,
    secret: null,
  });
  assert.equal(decision.ok, false);
  if (!decision.ok) assert.equal(decision.status, 403);
});

test("negativo: por encima del tope de US$0.50 el proveedor simulado no se llama", async () => {
  const { fake } = makeFakeSupabase();
  let ledger = emptyLedger(VIDEO_ID);
  ledger = recordSpend(ledger, "visual_test_v2", 0.48, "gasto previo simulado");
  await writeVisualTestV2Ledger(fake, BUCKET, ledger);
  const { provider, getCallCount } = makeCountingImageProvider();
  const decision = evaluateVisualTestV2RealRequest(ADMIN, { confirm: tokenFor(ADMIN.id) }, {
    env: ENV,
    nowMs: NOW,
    secret: SECRET,
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  await assert.rejects(
    () => runVisualTestV2RealGeneration(fake, decision.authorization, { bucket: BUCKET, imageProvider: provider }),
    (err: unknown) => err instanceof VideoCostGuardExceededError && err.reason === "visual_test_v2_cap",
  );
  assert.equal(getCallCount(), 0);
});

test("negativo: replay del mismo token se rechaza en el servidor y el proveedor no se vuelve a llamar", async () => {
  const { fake } = makeFakeSupabase();
  const token = tokenFor(ADMIN.id);
  const decision = evaluateVisualTestV2RealRequest(ADMIN, { confirm: token }, { env: ENV, nowMs: NOW, secret: SECRET });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  const first = makeCountingImageProvider();
  await runVisualTestV2RealGeneration(fake, decision.authorization, { bucket: BUCKET, imageProvider: first.provider });
  assert.equal(first.getCallCount(), 3);
  const replay = evaluateVisualTestV2RealRequest(ADMIN, { confirm: token }, { env: ENV, nowMs: NOW, secret: SECRET });
  assert.equal(replay.ok, true, "el HMAC sigue vigente; el rechazo es el consumo único del nonce");
  if (!replay.ok) return;
  const second = makeCountingImageProvider();
  await assert.rejects(
    () => runVisualTestV2RealGeneration(fake, replay.authorization, { bucket: BUCKET, imageProvider: second.provider }),
    (err: unknown) => err instanceof VisualTestV2SpendAuthorizationError && err.reason === "replay",
  );
  assert.equal(second.getCallCount(), 0);
});

/**
 * Dos creates del mismo nonce se cruzan dentro de upload. El primero que
 * reanuda escribe; el segundo ve el objeto y recibe el error de `upsert: false`.
 * No usa temporizadores: la barrera abre solo cuando las dos llamadas ya están dentro.
 */
function makeConcurrentNonceSupabase() {
  const files = new Map<string, Buffer>();
  let nonceReads = 0;
  let nonceWrites = 0;
  let openReads: () => void = () => {};
  let openWrites: () => void = () => {};
  const reads = new Promise<void>((resolve) => {
    openReads = resolve;
  });
  const writes = new Promise<void>((resolve) => {
    openWrites = resolve;
  });
  const isNonce = (path: string) => path.includes("/spend-nonces/");
  const fake = {
    storage: {
      from() {
        return {
          async download(path: string) {
            if (isNonce(path) && nonceReads < 2) {
              nonceReads += 1;
              if (nonceReads === 2) openReads();
              await reads;
            }
            const buf = files.get(path);
            if (!buf) return { data: null, error: { message: "not found" } };
            return {
              data: {
                async text() {
                  return buf.toString("utf8");
                },
                async arrayBuffer() {
                  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
                },
              },
              error: null,
            };
          },
          async upload(path: string, body: Buffer, options?: { upsert?: boolean }) {
            if (isNonce(path) && nonceWrites < 2) {
              nonceWrites += 1;
              if (nonceWrites === 2) openWrites();
              await writes;
            }
            if (isNonce(path) && options?.upsert === false && files.has(path)) {
              return { error: { message: "The resource already exists" } };
            }
            files.set(path, Buffer.from(body));
            return { error: null };
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return fake;
}

test("dos llamadas concurrentes con el mismo token: una sola reclama el nonce y como máximo una llega al proveedor", async () => {
  const claimSource = readFileSync("src/lib/video/long-form/visual-test-v2-storage.ts", "utf8");
  assert.match(claimSource, /upsert:\s*false/);
  const token = tokenFor(ADMIN.id, NOW);
  const decision = evaluateVisualTestV2RealRequest(ADMIN, { confirm: token }, { env: ENV, nowMs: NOW, secret: SECRET });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  const fake = makeConcurrentNonceSupabase();
  const provider = makeCountingImageProvider();
  const run = () =>
    runVisualTestV2RealGeneration(fake, decision.authorization, { bucket: BUCKET, imageProvider: provider.provider });
  const settled = await Promise.allSettled([run(), run()]);
  const fulfilled = settled.filter((item) => item.status === "fulfilled");
  const rejected = settled.filter((item) => item.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  const failure = rejected[0];
  assert.equal(failure.status, "rejected");
  assert.ok(failure.reason instanceof VisualTestV2SpendAuthorizationError);
  assert.equal(failure.reason.reason, "replay");
  assert.equal(provider.getCallCount(), 3);
  assert.equal(fulfilled[0].status, "fulfilled");
  assert.equal(fulfilled[0].value.paidApisCalled, true);
});

test("un token nuevo, después de uno ya usado, reutiliza las imágenes y no gasta otra vez", async () => {
  const { fake } = makeFakeSupabase();
  const firstDecision = evaluateVisualTestV2RealRequest(ADMIN, { confirm: tokenFor(ADMIN.id) }, {
    env: ENV,
    nowMs: NOW,
    secret: SECRET,
  });
  assert.equal(firstDecision.ok, true);
  if (!firstDecision.ok) return;
  await runVisualTestV2RealGeneration(fake, firstDecision.authorization, {
    bucket: BUCKET,
    imageProvider: makeCountingImageProvider().provider,
  });
  const secondDecision = evaluateVisualTestV2RealRequest(ADMIN, { confirm: tokenFor(ADMIN.id) }, {
    env: ENV,
    nowMs: NOW,
    secret: SECRET,
  });
  assert.equal(secondDecision.ok, true);
  if (!secondDecision.ok) return;
  const second = makeCountingImageProvider();
  const again = await runVisualTestV2RealGeneration(fake, secondDecision.authorization, {
    bucket: BUCKET,
    imageProvider: second.provider,
  });
  assert.equal(second.getCallCount(), 0);
  assert.equal(again.paidApisCalled, false);
  assert.equal(again.ledgerVisualTestV2SpentUsd, 0.15);
});

test("acceso directo al API: una confirmación que solo existe en el cliente no autoriza el gasto", async () => {
  const clientOnly = await attemptPaid(ADMIN, { confirm: "CONFIRMO_EN_EL_CLIENTE" });
  assert.equal(clientOnly.status, 403);
  assert.equal(clientOnly.calls, 0);
  const extraField = await attemptPaid(ADMIN, { confirm: tokenFor(ADMIN.id), confirmed: true });
  assert.equal(extraField.status, 400);
  assert.equal(extraField.calls, 0);
});

test("nav y UI: el no-admin no es admin; el admin sí; el enlace del header solo cuelga de ese gate y no entra en sm", () => {
  assert.equal(isCommandCenterAdmin(BETA, ENV), false);
  assert.equal(isCommandCenterAdmin(ADMIN, ENV), true);
  const layout = readFileSync("src/app/dashboard/layout.tsx", "utf8");
  const page = readFileSync("src/app/dashboard/long-form/visual-test-v2/page.tsx", "utf8");
  assert.match(layout, /showLongFormDryRun = isCommandCenterAdmin\(user\)/);
  assert.equal(layout.includes("isLongFormAllowlisted"), false);
  const desktop = layout.slice(layout.indexOf("showLongFormDryRun && ("), layout.indexOf("showPodcast &&", layout.indexOf("showLongFormDryRun && (")));
  assert.match(desktop, /xl:inline-block/);
  assert.equal(desktop.includes("sm:inline-block"), false);
  assert.match(page, /isCommandCenterAdmin\(user\)/);
  assert.match(page, /notFound\(\)/);
  assert.equal(page.includes("isLongFormAllowlisted"), false);
});

test("positivo: admin con autorización vigente llega al adaptador simulado y el máximo mostrado es US$0.50", async () => {
  const outcome = await attemptPaid(ADMIN, { confirm: tokenFor(ADMIN.id) });
  assert.equal(outcome.status, 200);
  assert.equal(outcome.calls, 3);
  assert.equal(outcome.authorization?.maxUsd, 0.5);
  assert.equal(outcome.result?.maxTotalUsd, 0.5);
  assert.equal(outcome.result?.paidApisCalled, true);
  assert.equal(outcome.result?.totalSpentThisRunUsd, 0.15);
});

test("un token verificado no se puede reescribir con un tope mayor", () => {
  const token = tokenFor(ADMIN.id);
  const verified = verifyVisualTestV2SpendAuthorization(token, ADMIN.id, NOW, SECRET);
  assert.ok(verified);
  assert.equal(verified.maxUsd, VISUAL_TEST_V2_MAX_USD);
  const [body] = token.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { maxUsd: number };
  payload.maxUsd = 50;
  const forgedBody = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const forged = `${forgedBody}.${token.split(".")[1]}`;
  assert.equal(verifyVisualTestV2SpendAuthorization(forged, ADMIN.id, NOW, SECRET), null);
});

test("el flujo normal de Long Form y Podcast Studio no importa este gate", () => {
  const paths = [
    "src/app/dashboard/long-form/new/actions.ts",
    "src/app/dashboard/long-form/new/page.tsx",
    "src/app/api/generate/[id]/confirm-production/route.ts",
    "src/lib/video/long-form/produce.ts",
    "src/app/dashboard/podcast/page.tsx",
    "src/lib/podcast/v3/studio.ts",
  ];
  for (const path of paths) {
    const source = readFileSync(path, "utf8");
    assert.equal(source.includes("visual-test-v2-spend-auth"), false, path);
    assert.equal(source.includes("/api/long-form/visual-test-v2"), false, path);
  }
});
