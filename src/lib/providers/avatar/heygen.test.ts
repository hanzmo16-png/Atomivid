import { test } from "node:test";
import assert from "node:assert/strict";
import { heygenAvatarProvider } from "./heygen";
import { AvatarProviderError } from "../types";

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const keys = Object.keys(vars);
  const originals = keys.map((k) => [k, process.env[k]] as const);
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (async () => {
    try {
      await fn();
    } finally {
      for (const [k, v] of originals) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  })();
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("createAvatar lanza not_configured sin HEYGEN_API_KEY", async () => {
  await withEnv({ HEYGEN_API_KEY: undefined }, async () => {
    await assert.rejects(
      () => heygenAvatarProvider.createAvatar({ photoBuffer: Buffer.from("x"), mimeType: "image/jpeg", consentGiven: true }),
      (err: unknown) => err instanceof AvatarProviderError && err.reason === "not_configured",
    );
  });
});

test("createAvatar lanza consent_missing si consentGiven es false, incluso con clave presente", async () => {
  await withEnv({ HEYGEN_API_KEY: "fake-key" }, async () => {
    await assert.rejects(
      () => heygenAvatarProvider.createAvatar({ photoBuffer: Buffer.from("x"), mimeType: "image/jpeg", consentGiven: false }),
      (err: unknown) => err instanceof AvatarProviderError && err.reason === "consent_missing",
    );
  });
});

test("createAvatar lanza invalid_response si la foto está vacía", async () => {
  await withEnv({ HEYGEN_API_KEY: "fake-key" }, async () => {
    await assert.rejects(
      () => heygenAvatarProvider.createAvatar({ photoBuffer: Buffer.alloc(0), mimeType: "image/jpeg", consentGiven: true }),
      (err: unknown) => err instanceof AvatarProviderError && err.reason === "invalid_response",
    );
  });
});

test("generateVideo lanza invalid_response si el guion excede el límite documentado (5000 caracteres)", async () => {
  await withEnv({ HEYGEN_API_KEY: "fake-key" }, async () => {
    await assert.rejects(
      () =>
        heygenAvatarProvider.generateVideo({
          providerAvatarId: "avatar-1",
          script: "a".repeat(5001),
          maxCostUsd: 100,
        }),
      (err: unknown) => err instanceof AvatarProviderError && err.reason === "invalid_response",
    );
  });
});

test("generateVideo lanza budget_exceeded si el costo estimado excede maxCostUsd", async () => {
  await withEnv({ HEYGEN_API_KEY: "fake-key", HEYGEN_COST_USD_PER_SECOND: "1" }, async () => {
    await assert.rejects(
      () =>
        heygenAvatarProvider.generateVideo({
          providerAvatarId: "avatar-1",
          script: "hola mundo, esto es una prueba de presupuesto",
          maxCostUsd: 0.01,
        }),
      (err: unknown) => err instanceof AvatarProviderError && err.reason === "budget_exceeded",
    );
  });
});

test("createAvatar exitoso con fetch mockeado (mock, no red real)", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async (url: string | URL | Request) => {
    assert.ok(String(url).includes("/v3/avatars"));
    return jsonResponse({ avatar_id: "avatar-123", status: "completed" });
  }) as typeof fetch;

  try {
    await withEnv({ HEYGEN_API_KEY: "fake-key" }, async () => {
      const result = await heygenAvatarProvider.createAvatar({
        photoBuffer: Buffer.from("fake-photo-bytes"),
        mimeType: "image/jpeg",
        consentGiven: true,
      });
      assert.equal(result.providerAvatarId, "avatar-123");
      assert.equal(result.status, "completed");
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateVideo exitoso: crea, sondea (processing → completed) y descarga con fetch mockeado", async () => {
  const originalFetch = global.fetch;
  let pollCount = 0;
  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/v3/videos") && init?.method === "POST") {
      return jsonResponse({ video_id: "video-abc" });
    }
    if (u.includes("/v3/videos/video-abc")) {
      pollCount += 1;
      if (pollCount === 1) return jsonResponse({ status: "processing" });
      return jsonResponse({ status: "completed", video_url: "https://example.test/fake-video.mp4" });
    }
    if (u.includes("fake-video.mp4")) {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }
    throw new Error(`URL inesperada en el mock: ${u}`);
  }) as typeof fetch;

  try {
    await withEnv({ HEYGEN_API_KEY: "fake-key", HEYGEN_POLL_TIMEOUT_MS: "5000" }, async () => {
      const result = await heygenAvatarProvider.generateVideo({
        providerAvatarId: "avatar-123",
        script: "Hola, este es un guion de prueba corto.",
        maxCostUsd: 100,
      });
      assert.equal(result.providerJobId, "video-abc");
      assert.ok(result.buffer.byteLength > 0);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("deleteAvatar nunca finge éxito si el proveedor falla — reporta deleted:false con motivo", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;

  try {
    await withEnv({ HEYGEN_API_KEY: "fake-key" }, async () => {
      const result = await heygenAvatarProvider.deleteAvatar("avatar-123");
      assert.equal(result.deleted, false);
      assert.ok(result.reason);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("estimateVideoCostUsd usa la MISMA fórmula que generateVideo (nunca diverge)", async () => {
  await withEnv({ HEYGEN_API_KEY: "fake-key", HEYGEN_COST_USD_PER_SECOND: "0.05" }, async () => {
    const script = "hola mundo, esto es una prueba de estimación de costo";
    const estimated = heygenAvatarProvider.estimateVideoCostUsd({ script });

    const originalFetch = global.fetch;
    global.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/v3/videos") && !u.match(/\/v3\/videos\/[^/]+$/)) return jsonResponse({ video_id: "video-cost" });
      return jsonResponse({ status: "completed", video_url: "https://example.test/fake-video.mp4" });
    }) as typeof fetch;
    try {
      const asset = await heygenAvatarProvider.generateVideo({ providerAvatarId: "avatar-1", script, maxCostUsd: 100 });
      assert.equal(asset.costUsd, estimated);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

test("cancelVideo nunca finge éxito si el proveedor falla — reporta cancelled:false con motivo", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;

  try {
    await withEnv({ HEYGEN_API_KEY: "fake-key" }, async () => {
      const result = await heygenAvatarProvider.cancelVideo("video-123");
      assert.equal(result.cancelled, false);
      assert.ok(result.reason);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("processWebhookPayload normaliza el evento *.success documentado por fuentes secundarias", () => {
  const result = heygenAvatarProvider.processWebhookPayload({ event: "avatar_video.success", event_data: { video_id: "video-abc" } });
  assert.deepEqual(result, { providerJobId: "video-abc", status: "completed" });
});

test("processWebhookPayload normaliza el evento *.fail", () => {
  const result = heygenAvatarProvider.processWebhookPayload({ event: "avatar_video.fail", event_data: { video_id: "video-abc" } });
  assert.deepEqual(result, { providerJobId: "video-abc", status: "failed" });
});

test("processWebhookPayload devuelve null (nunca lanza) ante un payload malformado o de evento desconocido", () => {
  assert.equal(heygenAvatarProvider.processWebhookPayload(null), null);
  assert.equal(heygenAvatarProvider.processWebhookPayload({ event: "avatar_video.success" }), null);
  assert.equal(heygenAvatarProvider.processWebhookPayload({ event: "some.other.event", event_data: { video_id: "x" } }), null);
});

// ÚLTIMA prueba del archivo a propósito: el circuit breaker es un
// singleton de módulo compartido entre pruebas — abrirlo aquí no debe
// contaminar ninguna prueba anterior. Usa checkAvatarStatus() (no
// deleteAvatar(), que atrapa sus propios errores y nunca rechaza) para
// poder observar el AvatarProviderError propagado directamente.

for (const failure of ["post", "persist", "poll"] as const) {
  test(`single creation POST and early job persistence on ${failure} failure`, async () => {
    const originalFetch = global.fetch;
    const calls: string[] = [];
    global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        calls.push("post");
        if (failure === "post") return new Response(null, { status: 503 });
        return new Response(JSON.stringify({ video_id: "accepted-job" }), { status: 200 });
      }
      calls.push("poll");
      return new Response(null, { status: 503 });
    }) as typeof fetch;
    try {
      await withEnv({ HEYGEN_API_KEY: "test-key" }, async () => {
        await assert.rejects(() => heygenAvatarProvider.generateVideo({
          providerAvatarId: "avatar", script: "Hola", voiceId: "voice", maxCostUsd: 100,
          onJobCreated: async (id) => {
            assert.equal(id, "accepted-job"); calls.push("persist");
            if (failure === "persist") throw new Error("database down");
          },
        }));
        assert.deepEqual(calls, failure === "post" ? ["post"] : failure === "persist" ? ["post", "persist"] : ["post", "persist", "poll"]);
        global.fetch = (async () => new Response(JSON.stringify({ status: "completed" }), { status: 200 })) as typeof fetch;
        await heygenAvatarProvider.checkVideoStatus("reset-after-test");
      });
    } finally { global.fetch = originalFetch; }
  });
}

test("tras 3 fallos recuperables consecutivos, el circuito se abre y se reporta como circuit_open (no un upstream_error genérico)", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;

  try {
    await withEnv({ HEYGEN_API_KEY: "fake-key" }, async () => {
      for (let i = 0; i < 3; i++) {
        await assert.rejects(
          () => heygenAvatarProvider.checkAvatarStatus(`avatar-circuit-${i}`),
          (err: unknown) => err instanceof AvatarProviderError && err.reason === "upstream_error",
        );
      }
      await assert.rejects(
        () => heygenAvatarProvider.checkAvatarStatus("avatar-circuit-final"),
        (err: unknown) => err instanceof AvatarProviderError && err.reason === "circuit_open",
      );
    });
  } finally {
    global.fetch = originalFetch;
  }
});
