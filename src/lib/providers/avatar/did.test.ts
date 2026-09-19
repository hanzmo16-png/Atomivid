import { test } from "node:test";
import assert from "node:assert/strict";
import { didAvatarProvider } from "./did";
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

test("createAvatar lanza not_configured sin DID_API_KEY", async () => {
  await withEnv({ DID_API_KEY: undefined }, async () => {
    await assert.rejects(
      () => didAvatarProvider.createAvatar({ photoBuffer: Buffer.from("x"), mimeType: "image/jpeg", consentGiven: true }),
      (err: unknown) => err instanceof AvatarProviderError && err.reason === "not_configured",
    );
  });
});

test("createAvatar lanza consent_missing si consentGiven es false, incluso con clave presente", async () => {
  await withEnv({ DID_API_KEY: "fake-key" }, async () => {
    await assert.rejects(
      () => didAvatarProvider.createAvatar({ photoBuffer: Buffer.from("x"), mimeType: "image/jpeg", consentGiven: false }),
      (err: unknown) => err instanceof AvatarProviderError && err.reason === "consent_missing",
    );
  });
});

test("createAvatar lanza invalid_response si la foto está vacía", async () => {
  await withEnv({ DID_API_KEY: "fake-key" }, async () => {
    await assert.rejects(
      () => didAvatarProvider.createAvatar({ photoBuffer: Buffer.alloc(0), mimeType: "image/jpeg", consentGiven: true }),
      (err: unknown) => err instanceof AvatarProviderError && err.reason === "invalid_response",
    );
  });
});

test("generateVideo lanza budget_exceeded si el costo estimado excede maxCostUsd", async () => {
  await withEnv({ DID_API_KEY: "fake-key", DID_COST_USD_PER_SECOND: "1" }, async () => {
    await assert.rejects(
      () =>
        didAvatarProvider.generateVideo({
          providerAvatarId: "img-1",
          script: "hola mundo, esto es una prueba de presupuesto",
          voiceId: "voice-1",
          maxCostUsd: 0.01,
        }),
      (err: unknown) => err instanceof AvatarProviderError && err.reason === "budget_exceeded",
    );
  });
});

test("generateVideo lanza invalid_response si faltan AMBOS audioUrl y voiceId", async () => {
  await withEnv({ DID_API_KEY: "fake-key" }, async () => {
    await assert.rejects(
      () =>
        didAvatarProvider.generateVideo({
          providerAvatarId: "img-1",
          script: "hola mundo, sin ninguna entrada de voz",
          maxCostUsd: 100,
        }),
      (err: unknown) => err instanceof AvatarProviderError && err.reason === "invalid_response",
    );
  });
});

test("generateVideo con audioUrl NUNCA exige voiceId y manda script.type=\"audio\" (flujo real de ATOMIVID: audio propio de ElevenLabs, nunca la síntesis propia de D-ID)", async () => {
  const originalFetch = global.fetch;
  let capturedBody: Record<string, unknown> | null = null;
  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/talks") && init?.method === "POST") {
      capturedBody = JSON.parse(init.body as string);
      return jsonResponse({ id: "talk-audio" });
    }
    return jsonResponse({ status: "done", result_url: "https://example.test/fake-video.mp4" });
  }) as typeof fetch;

  try {
    await withEnv({ DID_API_KEY: "fake-key" }, async () => {
      await didAvatarProvider.generateVideo({
        providerAvatarId: "img-1",
        script: "hola mundo, con audio propio",
        audioUrl: "https://storage.example.test/r1/narracion.mp3?token=firmado",
        maxCostUsd: 100,
      });
      assert.deepEqual((capturedBody as { script?: unknown } | null)?.script, {
        type: "audio",
        audio_url: "https://storage.example.test/r1/narracion.mp3?token=firmado",
      });
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("createAvatar lanza invalid_response si el mimeType no es image/jpeg ni image/png (confirmado en docs.d-id.com/reference/upload-an-image)", async () => {
  await withEnv({ DID_API_KEY: "fake-key" }, async () => {
    await assert.rejects(
      () => didAvatarProvider.createAvatar({ photoBuffer: Buffer.from("x"), mimeType: "image/webp", consentGiven: true }),
      (err: unknown) => err instanceof AvatarProviderError && err.reason === "invalid_response",
    );
  });
});

test("todas las llamadas usan Basic auth con la API key codificada en base64 (nunca la clave cruda)", async () => {
  const originalFetch = global.fetch;
  let capturedAuth: string | null = null;
  global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    return jsonResponse({ status: "done" });
  }) as typeof fetch;

  try {
    await withEnv({ DID_API_KEY: "usuario123:contraseña456" }, async () => {
      await didAvatarProvider.checkVideoStatus("talk-auth-check");
      assert.equal(capturedAuth, `Basic ${Buffer.from("usuario123:contraseña456", "utf8").toString("base64")}`);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("createAvatar exitoso con fetch mockeado (mock, no red real) — sin fase de entrenamiento, completa de inmediato", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async (url: string | URL | Request) => {
    assert.ok(String(url).includes("/images"));
    return jsonResponse({ id: "img-123" });
  }) as typeof fetch;

  try {
    await withEnv({ DID_API_KEY: "fake-key" }, async () => {
      const result = await didAvatarProvider.createAvatar({
        photoBuffer: Buffer.from("fake-photo-bytes"),
        mimeType: "image/jpeg",
        consentGiven: true,
      });
      assert.equal(result.providerAvatarId, "img-123");
      assert.equal(result.status, "completed");
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("checkAvatarStatus siempre devuelve completed (D-ID no tiene fase de entrenamiento asíncrona conocida)", async () => {
  const status = await didAvatarProvider.checkAvatarStatus("img-123");
  assert.equal(status, "completed");
});

test("generateVideo exitoso: crea, sondea (started → done) y descarga con fetch mockeado", async () => {
  const originalFetch = global.fetch;
  let pollCount = 0;
  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/talks") && init?.method === "POST") {
      return jsonResponse({ id: "talk-abc" });
    }
    if (u.includes("/talks/talk-abc")) {
      pollCount += 1;
      if (pollCount === 1) return jsonResponse({ status: "started" });
      return jsonResponse({ status: "done", result_url: "https://example.test/fake-video.mp4" });
    }
    if (u.includes("fake-video.mp4")) {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
    }
    throw new Error(`URL inesperada en el mock: ${u}`);
  }) as typeof fetch;

  try {
    await withEnv({ DID_API_KEY: "fake-key", DID_POLL_TIMEOUT_MS: "5000" }, async () => {
      const result = await didAvatarProvider.generateVideo({
        providerAvatarId: "img-123",
        script: "Hola, este es un guion de prueba corto.",
        voiceId: "voice-1",
        maxCostUsd: 100,
      });
      assert.equal(result.providerJobId, "talk-abc");
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
    await withEnv({ DID_API_KEY: "fake-key" }, async () => {
      const result = await didAvatarProvider.deleteAvatar("img-123");
      assert.equal(result.deleted, false);
      assert.ok(result.reason);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("estimateVideoCostUsd usa la MISMA fórmula que generateVideo (nunca diverge)", async () => {
  await withEnv({ DID_API_KEY: "fake-key", DID_COST_USD_PER_SECOND: "0.08" }, async () => {
    const script = "hola mundo, esto es una prueba de estimación de costo";
    const estimated = didAvatarProvider.estimateVideoCostUsd({ script });

    const originalFetch = global.fetch;
    global.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/talks") && !u.match(/\/talks\/[^/]+$/)) return jsonResponse({ id: "talk-cost" });
      return jsonResponse({ status: "done", result_url: "https://example.test/fake-video.mp4" });
    }) as typeof fetch;
    try {
      const asset = await didAvatarProvider.generateVideo({ providerAvatarId: "img-1", script, voiceId: "voice-1", maxCostUsd: 100 });
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
    await withEnv({ DID_API_KEY: "fake-key" }, async () => {
      const result = await didAvatarProvider.cancelVideo("talk-123");
      assert.equal(result.cancelled, false);
      assert.ok(result.reason);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("processWebhookPayload normaliza un status 'done' reconocido", () => {
  const result = didAvatarProvider.processWebhookPayload({ id: "talk-abc", status: "done" });
  assert.deepEqual(result, { providerJobId: "talk-abc", status: "completed" });
});

test("processWebhookPayload normaliza un status 'error'", () => {
  const result = didAvatarProvider.processWebhookPayload({ id: "talk-abc", status: "error" });
  assert.deepEqual(result, { providerJobId: "talk-abc", status: "failed" });
});

test("processWebhookPayload devuelve null (nunca lanza) ante un payload malformado o de status desconocido", () => {
  assert.equal(didAvatarProvider.processWebhookPayload(null), null);
  assert.equal(didAvatarProvider.processWebhookPayload({ status: "done" }), null);
  assert.equal(didAvatarProvider.processWebhookPayload({ id: "talk-abc", status: "algo-inventado" }), null);
});

for (const scenario of ["done", "started", "error", "missing_url", "empty", "download_error"] as const) {
  test(`recoverVideo ${scenario}: GET only, never resubmits`, async () => {
    await withEnv({ DID_API_KEY: "test-key" }, async () => {
      const originalFetch = global.fetch;
      const calls: string[] = [];
      global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        assert.equal(init?.method ?? "GET", "GET");
        calls.push(String(url));
        if (String(url).includes("/talks/")) {
          return jsonResponse({
            status: ["started", "error"].includes(scenario) ? scenario : "done",
            result_url: scenario === "missing_url" ? undefined : "https://example.test/video.mp4",
          });
        }
        return new Response(scenario === "empty" ? "" : "video-bytes", { status: scenario === "download_error" ? 403 : 200 });
      }) as typeof fetch;
      try {
        if (scenario === "done") {
          const result = await didAvatarProvider.recoverVideo!("talk-existing");
          assert.equal(result.providerJobId, "talk-existing");
          assert.equal(result.buffer.toString(), "video-bytes");
          assert.equal(calls.length, 2);
        } else {
          await assert.rejects(() => didAvatarProvider.recoverVideo!("talk-existing"), AvatarProviderError);
        }
        assert.ok(calls[0].endsWith("/talks/talk-existing"));
      } finally { global.fetch = originalFetch; }
    });
  });
}

// ÚLTIMA prueba del archivo a propósito: el circuit breaker es un
// singleton de módulo compartido entre pruebas — abrirlo aquí no debe
// contaminar ninguna prueba anterior. Usa checkVideoStatus() (no
// deleteAvatar()/cancelVideo(), que atrapan sus propios errores y nunca
// rechazan) para poder observar el AvatarProviderError propagado directamente.

for (const failure of ["post", "persist", "poll"] as const) {
  test(`single creation POST and early job persistence on ${failure} failure`, async () => {
    const originalFetch = global.fetch;
    const calls: string[] = [];
    global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        calls.push("post");
        if (failure === "post") return new Response(null, { status: 503 });
        return new Response(JSON.stringify({ id: "accepted-job" }), { status: 200 });
      }
      calls.push("poll");
      return new Response(null, { status: 503 });
    }) as typeof fetch;
    try {
      await withEnv({ DID_API_KEY: "test-key" }, async () => {
        await assert.rejects(() => didAvatarProvider.generateVideo({
          providerAvatarId: "avatar", script: "Hola", voiceId: "voice", maxCostUsd: 100,
          onJobCreated: async (id) => {
            assert.equal(id, "accepted-job"); calls.push("persist");
            if (failure === "persist") throw new Error("database down");
          },
        }));
        assert.deepEqual(calls, failure === "post" ? ["post"] : failure === "persist" ? ["post", "persist"] : ["post", "persist", "poll"]);
        global.fetch = (async () => new Response(JSON.stringify({ status: "done" }), { status: 200 })) as typeof fetch;
        await didAvatarProvider.checkVideoStatus("reset-after-test");
      });
    } finally { global.fetch = originalFetch; }
  });
}


test("D-ID errors preserve safe category and operation without leaking provider content or retrying creation", async () => {
  await withEnv({ DID_API_KEY: "test:secret" }, async () => {
    const original = globalThis.fetch;
    try {
      for (const body of [{ kind: "PermissionError", description: "private signed URL secret" }, { kind: "private-secret" }, null]) {
        let calls = 0;
        globalThis.fetch = async () => { calls++; return jsonResponse(body, 403); };
        await assert.rejects(() => didAvatarProvider.generateVideo({
          providerAvatarId: "image", script: "", audioUrl: "https://example.test/audio.wav",
          audioDurationSeconds: 1, maxCostUsd: 100,
        }), (error: unknown) => {
          assert.ok(error instanceof AvatarProviderError);
          assert.match(error.message, /HTTP 403 \[create_talk;/);
          assert.ok(!error.message.includes("private"));
          assert.ok(!error.message.includes("secret"));
          assert.ok(error.message.includes(body?.kind === "PermissionError" ? "PermissionError" : "unclassified"));
          return true;
        });
        assert.equal(calls, 1);
      }
    } finally { globalThis.fetch = original; }
  });
});

test("tras 3 fallos recuperables consecutivos, el circuito se abre y se reporta como circuit_open (no un upstream_error genérico)", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;

  try {
    await withEnv({ DID_API_KEY: "fake-key" }, async () => {
      for (let i = 0; i < 3; i++) {
        await assert.rejects(
          () => didAvatarProvider.checkVideoStatus(`talk-circuit-${i}`),
          (err: unknown) => err instanceof AvatarProviderError && err.reason === "upstream_error",
        );
      }
      await assert.rejects(
        () => didAvatarProvider.checkVideoStatus("talk-circuit-final"),
        (err: unknown) => err instanceof AvatarProviderError && err.reason === "circuit_open",
      );
    });
  } finally {
    global.fetch = originalFetch;
  }
});
