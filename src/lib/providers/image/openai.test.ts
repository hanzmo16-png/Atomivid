import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiImageProvider } from "./openai";
import { GenerativeProviderError } from "../types";

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

const BASE_REQUEST = { prompt: "una escena de prueba", aspectRatio: "9:16" as const, maxCostUsd: 1 };
const FAKE_PNG_B64 = Buffer.from("fake-png-bytes").toString("base64");

test("generateImage lanza not_configured sin OPENAI_API_KEY", async () => {
  await withEnv({ OPENAI_API_KEY: undefined }, async () => {
    await assert.rejects(
      () => openaiImageProvider.generateImage(BASE_REQUEST),
      (err: unknown) => err instanceof GenerativeProviderError && err.reason === "not_configured",
    );
  });
});

test("generateImage lanza budget_exceeded si el estimado estático (default 0.05) excede maxCostUsd", async () => {
  await withEnv({ OPENAI_API_KEY: "fake-key" }, async () => {
    await assert.rejects(
      () => openaiImageProvider.generateImage({ ...BASE_REQUEST, maxCostUsd: 0.01 }),
      (err: unknown) => err instanceof GenerativeProviderError && err.reason === "budget_exceeded",
    );
  });
});

test("generateImage envía exactamente model/prompt/size/quality/n al endpoint confirmado, con el header Authorization", async () => {
  const originalFetch = global.fetch;
  let capturedUrl: string | undefined;
  let capturedBody: Record<string, unknown> | undefined;
  let capturedAuth: string | null | undefined;
  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    capturedUrl = String(url);
    capturedBody = JSON.parse(String(init?.body));
    capturedAuth = (init?.headers as Record<string, string>)?.Authorization;
    return jsonResponse({ data: [{ b64_json: FAKE_PNG_B64 }] });
  }) as typeof fetch;

  try {
    await withEnv(
      { OPENAI_API_KEY: "sk-fake-test-key", OPENAI_IMAGE_MODEL: undefined, OPENAI_IMAGE_SIZE: undefined, OPENAI_IMAGE_QUALITY: undefined },
      async () => {
        await openaiImageProvider.generateImage(BASE_REQUEST);
        assert.equal(capturedUrl, "https://api.openai.com/v1/images/generations");
        assert.equal(capturedAuth, "Bearer sk-fake-test-key");
        assert.equal(capturedBody?.model, "gpt-image-2");
        assert.equal(capturedBody?.size, "1024x1536");
        assert.equal(capturedBody?.quality, "medium");
        assert.equal(capturedBody?.n, 1);
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateImage usa el tamaño landscape (16:9) sin afectar el tamaño portrait (9:16) por defecto", async () => {
  const originalFetch = global.fetch;
  const sizesSeen: string[] = [];
  global.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sizesSeen.push(body.size);
    return jsonResponse({ data: [{ b64_json: FAKE_PNG_B64 }] });
  }) as typeof fetch;

  try {
    await withEnv(
      { OPENAI_API_KEY: "sk-fake-test-key", OPENAI_IMAGE_SIZE: undefined, OPENAI_IMAGE_SIZE_LANDSCAPE: undefined },
      async () => {
        const portrait = await openaiImageProvider.generateImage({ ...BASE_REQUEST, aspectRatio: "9:16" });
        const landscape = await openaiImageProvider.generateImage({ ...BASE_REQUEST, aspectRatio: "16:9" });
        assert.equal(sizesSeen[0], "1024x1536");
        assert.equal(sizesSeen[1], "1536x1024");
        assert.equal(portrait.width, 1024);
        assert.equal(portrait.height, 1536);
        assert.equal(landscape.width, 1536);
        assert.equal(landscape.height, 1024);
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateImage decodifica correctamente una respuesta con b64_json", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => jsonResponse({ data: [{ b64_json: FAKE_PNG_B64 }] })) as typeof fetch;

  try {
    await withEnv({ OPENAI_API_KEY: "fake-key" }, async () => {
      const asset = await openaiImageProvider.generateImage(BASE_REQUEST);
      assert.equal(asset.buffer.toString(), "fake-png-bytes");
      assert.equal(asset.mimeType, "image/png");
      assert.equal(asset.model, "gpt-image-2");
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateImage calcula el costo real a partir de usage (tarifa por token) cuando la respuesta lo trae", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    jsonResponse({
      data: [{ b64_json: FAKE_PNG_B64 }],
      usage: { input_tokens: 20, output_tokens: 1500, input_tokens_details: { text_tokens: 20, image_tokens: 0 } },
    })) as typeof fetch;

  try {
    await withEnv({ OPENAI_API_KEY: "fake-key", OPENAI_IMAGE_ESTIMATED_COST_USD: "0.05" }, async () => {
      const asset = await openaiImageProvider.generateImage(BASE_REQUEST);
      // 20 tokens de texto * $5/1M + 1500 tokens de salida * $40/1M
      const expected = 20 * (5 / 1_000_000) + 1500 * (40 / 1_000_000);
      assert.ok(Math.abs(asset.costUsd - expected) < 1e-9);
      // El costo real calculado debe ganarle a la estimación estática, no usarla.
      assert.notEqual(asset.costUsd, 0.05);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateImage cae a la estimación estática si la respuesta no trae usage reconocible", async () => {
  // OPENAI_IMAGE_ESTIMATED_COST_USD (como el resto de constantes de
  // configuración de este adaptador) se lee UNA sola vez al importar el
  // módulo, no en cada llamada — por eso esta prueba no la sobreescribe
  // (no tendría efecto) y en cambio verifica el valor por defecto real
  // (0.05, ver DEFAULT arriba) que sí queda congelado desde el primer
  // import del archivo de pruebas.
  const originalFetch = global.fetch;
  global.fetch = (async () => jsonResponse({ data: [{ b64_json: FAKE_PNG_B64 }] })) as typeof fetch;

  try {
    await withEnv({ OPENAI_API_KEY: "fake-key" }, async () => {
      const asset = await openaiImageProvider.generateImage(BASE_REQUEST);
      assert.equal(asset.costUsd, 0.05);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateImage detecta un rechazo de moderación (HTTP 400 + 'moderation' en el cuerpo) y nunca reintenta", async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = (async () => {
    callCount += 1;
    return new Response(JSON.stringify({ error: { message: "Your request was rejected by moderation" } }), { status: 400 });
  }) as typeof fetch;

  try {
    await withEnv({ OPENAI_API_KEY: "fake-key" }, async () => {
      await assert.rejects(
        () => openaiImageProvider.generateImage(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "moderation_rejected",
      );
      // Nunca se reintenta un rechazo de moderación, aunque el default sea 1 reintento (2 llamadas) para otros errores.
      assert.equal(callCount, 1);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateImage lanza invalid_response si la imagen decodificada pesa 0 bytes", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () => jsonResponse({ data: [{ b64_json: "" }] })) as typeof fetch;

  try {
    await withEnv({ OPENAI_API_KEY: "fake-key" }, async () => {
      await assert.rejects(
        () => openaiImageProvider.generateImage(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "invalid_response",
      );
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateImage NO reintenta ante un timeout — consumo incierto, podría haberse cobrado del lado de OpenAI", async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = (async () => {
    callCount += 1;
    const err = new Error("aborted");
    err.name = "AbortError";
    throw err;
  }) as typeof fetch;

  try {
    await withEnv({ OPENAI_API_KEY: "fake-key" }, async () => {
      await assert.rejects(
        () => openaiImageProvider.generateImage(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "timeout",
      );
      assert.equal(callCount, 1, "un timeout nunca debe reintentarse automáticamente");
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateImage NO reintenta ante invalid_response (HTTP 200 con cuerpo corrupto) — un 200 OK típicamente ya implica cobro", async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = (async () => {
    callCount += 1;
    return jsonResponse({ data: [{ b64_json: "" }] });
  }) as typeof fetch;

  try {
    await withEnv({ OPENAI_API_KEY: "fake-key" }, async () => {
      await assert.rejects(
        () => openaiImageProvider.generateImage(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "invalid_response",
      );
      assert.equal(callCount, 1, "invalid_response nunca debe reintentarse automáticamente");
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateImage NO reintenta un HTTP 500 — no prueba que OpenAI no generó (incierto)", async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = (async () => {
    callCount += 1;
    return new Response(null, { status: 500 });
  }) as typeof fetch;

  try {
    await withEnv({ OPENAI_API_KEY: "fake-key" }, async () => {
      await assert.rejects(
        () => openaiImageProvider.generateImage(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.chargeOutcome === "uncertain",
      );
      assert.equal(callCount, 1);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateImage NO reintenta una conexión cortada con la solicitud en vuelo (ECONNRESET)", async () => {
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = (async () => {
    callCount += 1;
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
  }) as typeof fetch;

  try {
    await withEnv({ OPENAI_API_KEY: "fake-key" }, async () => {
      await assert.rejects(
        () => openaiImageProvider.generateImage(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.chargeOutcome === "uncertain",
      );
      assert.equal(callCount, 1);
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("generateImage reintenta hasta MAX_RETRIES (default=1, congelado al importar el módulo) solo si la solicitud no salió, y no más", async () => {
  // Igual que ESTIMATED_COST_USD, OPENAI_IMAGE_MAX_RETRIES se lee una sola
  // vez al importar — por eso esta prueba verifica el comportamiento con
  // el valor por defecto (1 reintento = 2 llamadas en total) en vez de
  // intentar sobreescribirlo en caliente. La validación real de
  // MAX_RETRIES=0 para la llamada de producción se hace fijando la
  // variable de entorno ANTES de arrancar el proceso (ver workflow
  // validate-openai-image.yml), que es como esta constante sí toma efecto.
  const originalFetch = global.fetch;
  let callCount = 0;
  global.fetch = (async () => {
    callCount += 1;
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
  }) as typeof fetch;

  try {
    await withEnv({ OPENAI_API_KEY: "fake-key" }, async () => {
      await assert.rejects(
        () => openaiImageProvider.generateImage(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.chargeOutcome === "not_sent",
      );
      assert.equal(callCount, 2);
    });
  } finally {
    global.fetch = originalFetch;
  }
});
