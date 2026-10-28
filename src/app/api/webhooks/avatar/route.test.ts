import { createHmac } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
// La ruta vive en "[provider]/route.ts" (segmento dinámico de Next.js) —
// este archivo de pruebas se deja FUERA de esa carpeta a propósito: el
// runner de pruebas de Node (`node --test`) interpreta "[provider]" como
// un patrón glob de un solo carácter al resolver rutas por CLI y nunca
// encuentra el archivo si vive adentro (confirmado: "node --test
// 'src/app/.../[provider]/route.test.ts'" reporta 0 pruebas encontradas,
// aunque el mismo archivo ejecutado directamente sí las corre todas). El
// import relativo de abajo no tiene ese problema — solo la resolución de
// archivos por CLI de node:test lo tiene.
import { POST } from "./[provider]/route";

const KEYS = ["AVATAR_MODE_ENABLED", "AVATAR_WEBHOOK_SECRET", "HEYGEN_WEBHOOK_SECRET"];

async function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const originals = KEYS.map((k) => [k, process.env[k]] as const);
  for (const k of KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of originals) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function makeRequest(headers: Record<string, string> = {}, body: unknown = { providerJobId: "x", status: "completed" }): Request {
  return new Request("https://atomivid.test/api/webhooks/avatar/fixture", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// Estas pruebas cubren SOLO los caminos que nunca llegan a Supabase (el
// flujo completo con una actualización real se prueba en webhook.test.ts,
// con la base de datos inyectada como fake — nunca red real).

test("responde 404 (sin revelar la ruta) si AVATAR_MODE_ENABLED está apagado", async () => {
  await withEnv({ AVATAR_MODE_ENABLED: "false", AVATAR_WEBHOOK_SECRET: "s3cret" }, async () => {
    const response = await POST(makeRequest({ "x-atomivid-webhook-secret": "s3cret" }), {
      params: Promise.resolve({ provider: "fixture" }),
    });
    assert.equal(response.status, 404);
  });
});

test("responde 401 si falta el header del secreto", async () => {
  await withEnv({ AVATAR_MODE_ENABLED: "true", AVATAR_WEBHOOK_SECRET: "s3cret" }, async () => {
    const response = await POST(makeRequest({}), { params: Promise.resolve({ provider: "fixture" }) });
    assert.equal(response.status, 401);
  });
});

test("responde 401 si el secreto no coincide", async () => {
  await withEnv({ AVATAR_MODE_ENABLED: "true", AVATAR_WEBHOOK_SECRET: "s3cret" }, async () => {
    const response = await POST(makeRequest({ "x-atomivid-webhook-secret": "wrong" }), {
      params: Promise.resolve({ provider: "fixture" }),
    });
    assert.equal(response.status, 401);
  });
});

test("responde 401 si AVATAR_WEBHOOK_SECRET no está configurado, incluso si el header trae algo", async () => {
  await withEnv({ AVATAR_MODE_ENABLED: "true", AVATAR_WEBHOOK_SECRET: undefined }, async () => {
    const response = await POST(makeRequest({ "x-atomivid-webhook-secret": "anything" }), {
      params: Promise.resolve({ provider: "fixture" }),
    });
    assert.equal(response.status, 401);
  });
});

test("responde 404 para un proveedor desconocido, ya autenticado", async () => {
  await withEnv({ AVATAR_MODE_ENABLED: "true", AVATAR_WEBHOOK_SECRET: "s3cret" }, async () => {
    const response = await POST(makeRequest({ "x-atomivid-webhook-secret": "s3cret" }), {
      params: Promise.resolve({ provider: "not-a-real-provider" }),
    });
    assert.equal(response.status, 404);
  });
});

test("SIMULATED firma HeyGen v3: una firma mala no entra y un evento que no es el video responde 400 sin crear nada", async () => {
  const secret = "whsec_simulated_only";
  const body = JSON.stringify({ event_type: "avatar_video_gif.success", event_data: { video_id: "vid_gif" } });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  await withEnv({ AVATAR_MODE_ENABLED: "true", HEYGEN_WEBHOOK_SECRET: secret }, async () => {
    const bad = await POST(new Request("https://atomivid.test/api/webhooks/avatar/heygen", { method: "POST", headers: { "content-type": "application/json", signature: "ab".repeat(32) }, body }), { params: Promise.resolve({ provider: "heygen" }) });
    assert.equal(bad.status, 401);
    assert.equal(JSON.stringify(await bad.json()).includes(secret), false);
    const ok = await POST(new Request("https://atomivid.test/api/webhooks/avatar/heygen", { method: "POST", headers: { "content-type": "application/json", signature }, body }), { params: Promise.resolve({ provider: "heygen" }) });
    assert.equal(ok.status, 400);
    assert.equal(JSON.stringify(await ok.json()).includes(secret), false);
  });
});

test("SIMULATED HeyGen: falta la firma, el cuerpo no coincide con la firma, y el secreto propio no salta el HMAC", async () => {
  const secret = "whsec_simulated_only";
  const raw = '{ "event_type" : "avatar_video_gif.success" , "event_data" : { "video_id" : "vid_gif" } }';
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  const reserialized = createHmac("sha256", secret).update(JSON.stringify(JSON.parse(raw))).digest("hex");
  assert.notEqual(signature, reserialized);
  const heygen = (headers: Record<string, string>, body: string) => new Request("https://atomivid.test/api/webhooks/avatar/heygen", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  await withEnv({ AVATAR_MODE_ENABLED: "true", HEYGEN_WEBHOOK_SECRET: secret, AVATAR_WEBHOOK_SECRET: "s3cret" }, async () => {
    const missing = await POST(heygen({}, raw), { params: Promise.resolve({ provider: "heygen" }) });
    assert.equal(missing.status, 401);
    const tampered = await POST(heygen({ signature: reserialized }, raw), { params: Promise.resolve({ provider: "heygen" }) });
    assert.equal(tampered.status, 401);
    const bypass = await POST(heygen({ "x-atomivid-webhook-secret": "s3cret" }, raw), { params: Promise.resolve({ provider: "heygen" }) });
    assert.equal(bypass.status, 401);
    const rawOk = await POST(heygen({ signature }, raw), { params: Promise.resolve({ provider: "heygen" }) });
    assert.equal(rawOk.status, 400);
    for (const response of [missing, tampered, bypass, rawOk]) {
      assert.equal(JSON.stringify(await response.json()).includes(secret), false);
    }
  });
  await withEnv({ AVATAR_MODE_ENABLED: "true", AVATAR_WEBHOOK_SECRET: "s3cret" }, async () => {
    const headerOnly = await POST(heygen({ "x-atomivid-webhook-secret": "s3cret" }, raw), { params: Promise.resolve({ provider: "heygen" }) });
    assert.equal(headerOnly.status, 400);
  });
});

test("responde 400 ante un cuerpo que no es JSON válido, ya autenticado con proveedor válido", async () => {
  await withEnv({ AVATAR_MODE_ENABLED: "true", AVATAR_WEBHOOK_SECRET: "s3cret" }, async () => {
    const request = new Request("https://atomivid.test/api/webhooks/avatar/fixture", {
      method: "POST",
      headers: { "content-type": "application/json", "x-atomivid-webhook-secret": "s3cret" },
      body: "esto no es JSON",
    });
    const response = await POST(request, { params: Promise.resolve({ provider: "fixture" }) });
    assert.equal(response.status, 400);
  });
});
