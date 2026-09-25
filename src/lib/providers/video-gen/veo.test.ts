import { test } from "node:test";
import assert from "node:assert/strict";
import { veoVideoProvider, VEO_MODEL, getVeoCostUsdPerSecond, VEO_DURATION_SECONDS_1080P } from "./veo";
import { GenerativeProviderError } from "../types";

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const keys = ["VEO_API_KEY", "VEO_API_BASE", "VEO_POLL_TIMEOUT_MS", "VEO_MAX_POLL_ATTEMPTS", "VEO_COST_USD_PER_SECOND"];
  const originals = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v !== undefined) process.env[k] = v;
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

const REFERENCE_IMAGE_URL = "https://storage.example.com/approved-reference.png";
const FAKE_PNG_BYTES = Buffer.from("\x89PNG\r\n\x1a\n\x01\x02\x03\x04\x05\x06\x07\x08", "latin1");

function imageResponse(mimeType: string | undefined = "image/png", bytes: Buffer = FAKE_PNG_BYTES): Response {
  const headers: Record<string, string> = {};
  if (mimeType) headers["content-type"] = mimeType;
  // Cast necesario: un Buffer recibido por parámetro tipa como Buffer<ArrayBufferLike>,
  // que TS no reconoce como BodyInit aunque un Buffer.from(...) inline sí lo haga
  // (mismo valor en runtime, solo una diferencia de inferencia de tipos).
  return new Response(bytes as unknown as BodyInit, { status: 200, headers });
}

const BASE_REQUEST = {
  prompt: "a group of people transporting a massive stone pillar",
  negativePrompt: "modern machinery, vehicles",
  aspectRatio: "16:9" as const,
  durationSeconds: 8,
  maxCostUsd: 2,
  referenceImageUrl: REFERENCE_IMAGE_URL,
};

const COMPLETED_OPERATION = (name: string, videoUri: string) => ({
  name,
  done: true,
  response: { generateVideoResponse: { generatedSamples: [{ video: { uri: videoUri, mimeType: "video/mp4" } }] } },
});

/** Instala un fetch simulado que enruta por sustring de URL — nunca toca la red real. Ningún test de este archivo hace una llamada HTTP real. */
function installFetchMock(handler: (url: string, init: RequestInit | undefined) => Promise<Response> | Response) {
  const originalFetch = global.fetch;
  global.fetch = (async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
  return () => {
    global.fetch = originalFetch;
  };
}

/** Handler base reutilizado por los tests de fallo/async — sirve la imagen de referencia y delega el resto al handler específico del test. */
function withReferenceImageMock(handler: (url: string, init: RequestInit | undefined) => Promise<Response> | Response) {
  return (url: string, init: RequestInit | undefined) => {
    if (url === REFERENCE_IMAGE_URL) return imageResponse();
    return handler(url, init);
  };
}

test("veoVideoProvider cumple la interfaz VideoProvider", () => {
  assert.equal(veoVideoProvider.name, "veo");
  assert.deepEqual(veoVideoProvider.capabilities.aspectRatios, ["16:9", "9:16"]);
  assert.deepEqual(veoVideoProvider.capabilities.models, [VEO_MODEL]);
});

test("generateVideo() lanza not_configured sin VEO_API_KEY — cero llamadas de red", async () => {
  await withEnv({}, async () => {
    let fetchCalled = false;
    const restore = installFetchMock(async () => {
      fetchCalled = true;
      throw new Error("no debería llamarse");
    });
    try {
      await assert.rejects(
        () => veoVideoProvider.generateVideo(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "not_configured",
      );
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });
});

test("generateVideo() lanza invalid_request si falta referenceImageUrl — NUNCA cae a text-to-video automáticamente (hard failure, no fallback)", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    let fetchCalled = false;
    const restore = installFetchMock(async () => {
      fetchCalled = true;
      throw new Error("no debería llamarse");
    });
    try {
      const { referenceImageUrl: _omit, ...withoutImage } = BASE_REQUEST;
      void _omit;
      await assert.rejects(
        () => veoVideoProvider.generateVideo(withoutImage),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "invalid_request",
      );
      assert.equal(fetchCalled, false);
    } finally {
      restore();
    }
  });
});

test("generateVideo() lanza budget_exceeded si el costo estimado ($0.96) excede maxCostUsd", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    await assert.rejects(
      () => veoVideoProvider.generateVideo({ ...BASE_REQUEST, maxCostUsd: 0.5 }),
      (err: unknown) => err instanceof GenerativeProviderError && err.reason === "budget_exceeded",
    );
  });
});

test("mapeo del request (P2A.6 + corrección post-incidente real): la imagen de referencia se descarga server-side y se envía como objeto Image {bytesBase64Encoded, mimeType} — NUNCA como {uri} ni {imageBytes}", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedUrl: string | undefined;
    let capturedAuth: string | undefined;
    let imageFetchCalled = false;
    const restore = installFetchMock(async (url, init) => {
      if (url === REFERENCE_IMAGE_URL) {
        imageFetchCalled = true;
        return imageResponse("image/png");
      }
      if (url.includes(":predictLongRunning")) {
        capturedUrl = url;
        capturedBody = JSON.parse(String(init?.body));
        capturedAuth = (init?.headers as Record<string, string>)?.["x-goog-api-key"];
        return jsonResponse({ name: "operations/op-1" });
      }
      if (url.includes("operations/op-1")) return jsonResponse(COMPLETED_OPERATION("operations/op-1", "https://files.example.com/out.mp4"));
      if (url.includes("files.example.com")) return new Response(Buffer.from("fake-mp4-bytes"), { status: 200 });
      throw new Error(`URL no esperada en el mock: ${url}`);
    });
    try {
      await veoVideoProvider.generateVideo(BASE_REQUEST);
      assert.equal(imageFetchCalled, true);
      assert.ok(capturedUrl?.includes(`models/${VEO_MODEL}:predictLongRunning`));
      assert.equal(capturedAuth, "fake-key");
      const instances = capturedBody?.instances as Record<string, unknown>[];
      const image = instances[0].image as Record<string, unknown>;
      assert.equal("uri" in image, false, "el objeto image NUNCA debe llevar 'uri' — corrección P2A.6");
      assert.equal("imageBytes" in image, false, "el objeto image NUNCA debe llevar 'imageBytes' — es el nombre del SDK, no del JSON de wire; Google respondió HTTP 400 real con este campo (P2B, 2026-09-24)");
      assert.deepEqual(Object.keys(image).sort(), ["bytesBase64Encoded", "mimeType"], "el objeto image debe tener EXACTAMENTE estas dos claves, nada más");
      assert.equal(typeof image.bytesBase64Encoded, "string");
      assert.equal(image.bytesBase64Encoded, FAKE_PNG_BYTES.toString("base64"));
      assert.equal(image.mimeType, "image/png");
      assert.match(instances[0].prompt as string, /Avoid: modern machinery, vehicles/);
      const parameters = capturedBody?.parameters as Record<string, unknown>;
      assert.equal(parameters.aspectRatio, "16:9");
      assert.equal(parameters.resolution, "1080p");
      assert.equal(parameters.durationSeconds, VEO_DURATION_SECONDS_1080P);
    } finally {
      restore();
    }
  });
});

test("mapeo del MIME type: usa el content-type de la respuesta cuando es un tipo image/*", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    let capturedImage: Record<string, unknown> | undefined;
    const restore = installFetchMock(async (url, init) => {
      if (url === REFERENCE_IMAGE_URL) return imageResponse("image/jpeg");
      if (url.includes(":predictLongRunning")) {
        const body = JSON.parse(String(init?.body));
        capturedImage = body.instances[0].image;
        return jsonResponse({ name: "operations/op-mime" });
      }
      if (url.includes("operations/op-mime")) return jsonResponse(COMPLETED_OPERATION("operations/op-mime", "https://files.example.com/out.mp4"));
      return new Response(Buffer.from("bytes"), { status: 200 });
    });
    try {
      await veoVideoProvider.generateVideo(BASE_REQUEST);
      assert.equal(capturedImage?.mimeType, "image/jpeg");
    } finally {
      restore();
    }
  });
});

test("mapeo del MIME type: si el content-type falta o es genérico, se detecta por firma de bytes (PNG) — nunca se envía un mimeType inventado sin fundamento", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    let capturedImage: Record<string, unknown> | undefined;
    const restore = installFetchMock(async (url, init) => {
      if (url === REFERENCE_IMAGE_URL) return imageResponse("application/octet-stream"); // content-type genérico -> debe caer a sniff de bytes
      if (url.includes(":predictLongRunning")) {
        const body = JSON.parse(String(init?.body));
        capturedImage = body.instances[0].image;
        return jsonResponse({ name: "operations/op-sniff" });
      }
      if (url.includes("operations/op-sniff")) return jsonResponse(COMPLETED_OPERATION("operations/op-sniff", "https://files.example.com/out.mp4"));
      return new Response(Buffer.from("bytes"), { status: 200 });
    });
    try {
      await veoVideoProvider.generateVideo(BASE_REQUEST);
      assert.equal(capturedImage?.mimeType, "image/png"); // FAKE_PNG_BYTES trae la firma PNG real
    } finally {
      restore();
    }
  });
});

test("fallo al leer la imagen de referencia (HTTP no-200) se normaliza a invalid_request — nunca llega a enviar la generación", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    let predictCalled = false;
    const restore = installFetchMock(async (url) => {
      if (url === REFERENCE_IMAGE_URL) return new Response("not found", { status: 404 });
      predictCalled = true;
      throw new Error("no debería llegar aquí");
    });
    try {
      await assert.rejects(
        () => veoVideoProvider.generateVideo(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "invalid_request",
      );
      assert.equal(predictCalled, false);
    } finally {
      restore();
    }
  });
});

test("async lifecycle: reference image -> submit -> operation -> poll (varios intentos con done=false) -> COMPLETE -> download AUTENTICADO -> GenerativeAsset normalizado", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    let pollCount = 0;
    let downloadAuthHeader: string | null | undefined;
    const restore = installFetchMock(
      withReferenceImageMock(async (url, init) => {
        if (url.includes(":predictLongRunning")) return jsonResponse({ name: "operations/op-2" });
        if (url.includes("operations/op-2")) {
          pollCount++;
          if (pollCount < 3) return jsonResponse({ name: "operations/op-2", done: false });
          return jsonResponse(COMPLETED_OPERATION("operations/op-2", "https://files.example.com/out2.mp4"));
        }
        if (url.includes("files.example.com")) {
          downloadAuthHeader = (init?.headers as Record<string, string>)?.["x-goog-api-key"];
          return new Response(Buffer.from("fake-mp4-bytes-2"), { status: 200 });
        }
        throw new Error(`URL no esperada: ${url}`);
      }),
    );
    try {
      const asset = await veoVideoProvider.generateVideo(BASE_REQUEST);
      assert.equal(pollCount, 3);
      assert.equal(downloadAuthHeader, "fake-key", "la descarga del video debe incluir autenticación");
      assert.equal(asset.mimeType, "video/mp4");
      assert.equal(asset.extension, "mp4");
      assert.equal(asset.durationSeconds, VEO_DURATION_SECONDS_1080P);
      assert.equal(asset.model, VEO_MODEL);
      assert.equal(asset.costUsd, VEO_DURATION_SECONDS_1080P * getVeoCostUsdPerSecond());
      assert.equal(asset.providerJobId, "operations/op-2");
      assert.equal(asset.sourceHasGeneratedAudio, true);
      assert.ok(asset.buffer.byteLength > 0);
    } finally {
      restore();
    }
  });
});

test("resumeGeneration() (RC mission Fase 5): reanuda el sondeo de una operación YA enviada — CERO llamadas a predictLongRunning", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    let submitCalls = 0;
    let pollCount = 0;
    const restore = installFetchMock((url) => {
      if (url.includes(":predictLongRunning")) {
        submitCalls++;
        return jsonResponse({ name: "operations/should-never-be-created" });
      }
      if (url.includes("operations/op-resume")) {
        pollCount++;
        if (pollCount < 2) return jsonResponse({ name: "operations/op-resume", done: false });
        return jsonResponse(COMPLETED_OPERATION("operations/op-resume", "https://files.example.com/out-resume.mp4"));
      }
      if (url.includes("files.example.com")) return new Response(Buffer.from("resumed-bytes"), { status: 200 });
      throw new Error(`URL no esperada: ${url}`);
    });
    try {
      const asset = await veoVideoProvider.resumeGeneration!("operations/op-resume", BASE_REQUEST);
      assert.equal(submitCalls, 0, "resumeGeneration NUNCA debe enviar una nueva solicitud predictLongRunning");
      assert.equal(pollCount, 2);
      assert.equal(asset.providerJobId, "operations/op-resume");
      assert.equal(asset.costUsd, VEO_DURATION_SECONDS_1080P * getVeoCostUsdPerSecond());
      assert.ok(asset.buffer.byteLength > 0);
    } finally {
      restore();
    }
  });
});

test("resumeGeneration() lanza not_configured sin VEO_API_KEY — cero llamadas de red", async () => {
  await withEnv({}, async () => {
    const restore = installFetchMock(() => {
      throw new Error("no debería llamarse a fetch");
    });
    try {
      await assert.rejects(
        () => veoVideoProvider.resumeGeneration!("operations/op-x", BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "not_configured",
      );
    } finally {
      restore();
    }
  });
});

test("resiliencia (P2B, 2026-09-24): un fallo transitorio al CONSULTAR la operación (p. ej. HTTP 503) se reintenta dentro del mismo presupuesto de intentos — nunca aborta toda la generación ni crea una segunda operación", async () => {
  await withEnv({ VEO_API_KEY: "fake-key", VEO_MAX_POLL_ATTEMPTS: "2", VEO_POLL_TIMEOUT_MS: "999999" }, async () => {
    let pollCalls = 0;
    let submitCalls = 0;
    const restore = installFetchMock(
      withReferenceImageMock(async (url) => {
        if (url.includes(":predictLongRunning")) {
          submitCalls++;
          return jsonResponse({ name: "operations/op-resilient" });
        }
        if (url.includes("operations/op-resilient")) {
          pollCalls++;
          if (pollCalls === 1) return jsonResponse({ error: { message: "The service is currently unavailable." } }, 503);
          return jsonResponse(COMPLETED_OPERATION("operations/op-resilient", "https://files.example.com/out-resilient.mp4"));
        }
        if (url.includes("files.example.com")) return new Response(Buffer.from("bytes"), { status: 200 });
        throw new Error(`URL no esperada: ${url}`);
      }),
    );
    try {
      const asset = await veoVideoProvider.generateVideo(BASE_REQUEST);
      assert.equal(pollCalls, 2, "el primer 503 debe reintentarse, no abortar");
      assert.equal(submitCalls, 1, "NUNCA debe volver a llamar predictLongRunning tras un 503 de polling — misma operación");
      assert.equal(asset.providerJobId, "operations/op-resilient");
    } finally {
      restore();
    }
  });
});

test("resiliencia (P2B, 2026-09-24): si el fallo transitorio de consulta persiste hasta agotar los intentos, el error final SIGUE llevando el operationId — nunca se pierde aunque termine fallando de verdad", async () => {
  await withEnv({ VEO_API_KEY: "fake-key", VEO_MAX_POLL_ATTEMPTS: "1", VEO_POLL_TIMEOUT_MS: "999999" }, async () => {
    let submitCalls = 0;
    const restore = installFetchMock(
      withReferenceImageMock(async (url) => {
        if (url.includes(":predictLongRunning")) {
          submitCalls++;
          return jsonResponse({ name: "operations/op-lost" });
        }
        if (url.includes("operations/op-lost")) return new Response("service unavailable", { status: 503 });
        throw new Error(`URL no esperada: ${url}`);
      }),
    );
    try {
      let caught: unknown;
      try {
        await veoVideoProvider.generateVideo(BASE_REQUEST);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof GenerativeProviderError);
      assert.equal((caught as GenerativeProviderError).providerJobId, "operations/op-lost");
      assert.equal(submitCalls, 1, "un fallo de polling agotado NUNCA debe disparar una segunda submitGeneration");
    } finally {
      restore();
    }
  });
});

test("costo = $0.96 exactos para 8s a 1080p ($0.12/s)", () => {
  assert.equal(VEO_DURATION_SECONDS_1080P * getVeoCostUsdPerSecond(), 0.96);
});

test("fallo del proveedor (HTTP 400 al enviar) se normaliza a invalid_request, nunca un Error genérico", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    const restore = installFetchMock(
      withReferenceImageMock(async (url) => {
        if (url.includes(":predictLongRunning")) return jsonResponse({ error: { message: "invalid_argument: bad prompt" } }, 400);
        throw new Error("no debería llegar más lejos");
      }),
    );
    try {
      await assert.rejects(
        () => veoVideoProvider.generateVideo(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "invalid_request",
      );
    } finally {
      restore();
    }
  });
});

test("regresión (P2B, 2026-09-24): si Google alguna vez volviera a rechazar el campo de imagen con el mensaje real observado, se sigue normalizando a invalid_request — nunca un Error genérico sin clasificar", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    const restore = installFetchMock(
      withReferenceImageMock(async (url) => {
        if (url.includes(":predictLongRunning")) {
          return jsonResponse(
            { error: { message: "`imageBytes` isn't supported by this model. Please remove it or refer to the Gemini API documentation for supported usage." } },
            400,
          );
        }
        throw new Error("no debería llegar más lejos");
      }),
    );
    try {
      await assert.rejects(
        () => veoVideoProvider.generateVideo(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "invalid_request",
      );
    } finally {
      restore();
    }
  });
});

test("fallo de autenticación (HTTP 401) se normaliza a authentication_error", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    const restore = installFetchMock(
      withReferenceImageMock(async (url) => {
        if (url.includes(":predictLongRunning")) return jsonResponse({ error: { message: "unauthenticated" } }, 401);
        throw new Error("no debería llegar más lejos");
      }),
    );
    try {
      await assert.rejects(
        () => veoVideoProvider.generateVideo(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "authentication_error",
      );
    } finally {
      restore();
    }
  });
});

test("rate limit (HTTP 429) se normaliza a rate_limited", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    const restore = installFetchMock(
      withReferenceImageMock(async (url) => {
        if (url.includes(":predictLongRunning")) return jsonResponse({ error: { message: "RESOURCE_EXHAUSTED: too many requests" } }, 429);
        throw new Error("no debería llegar más lejos");
      }),
    );
    try {
      await assert.rejects(
        () => veoVideoProvider.generateVideo(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "rate_limited",
      );
    } finally {
      restore();
    }
  });
});

test("cuota agotada (mensaje con 'quota') se normaliza a quota_exceeded, distinto de rate_limited", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    const restore = installFetchMock(
      withReferenceImageMock(async (url) => {
        if (url.includes(":predictLongRunning")) return jsonResponse({ error: { message: "RESOURCE_EXHAUSTED: quota exceeded for this project" } }, 429);
        throw new Error("no debería llegar más lejos");
      }),
    );
    try {
      await assert.rejects(
        () => veoVideoProvider.generateVideo(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "quota_exceeded",
      );
    } finally {
      restore();
    }
  });
});

test("rechazo por moderación/safety en la operación se normaliza a moderation_rejected", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    const restore = installFetchMock(
      withReferenceImageMock(async (url) => {
        if (url.includes(":predictLongRunning")) return jsonResponse({ name: "operations/op-safety" });
        if (url.includes("operations/op-safety")) {
          return jsonResponse({ name: "operations/op-safety", done: true, error: { code: 3, message: "Blocked by safety filters" } });
        }
        throw new Error("no debería llegar más lejos");
      }),
    );
    try {
      await assert.rejects(
        () => veoVideoProvider.generateVideo(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "moderation_rejected",
      );
    } finally {
      restore();
    }
  });
});

test("timeout: se agota el número máximo de intentos de sondeo sin done=true -> reason='timeout' (bounded: MAX_POLL_ATTEMPTS=1 evita esperas reales largas en el test)", async () => {
  await withEnv({ VEO_API_KEY: "fake-key", VEO_MAX_POLL_ATTEMPTS: "1", VEO_POLL_TIMEOUT_MS: "999999" }, async () => {
    const restore = installFetchMock(
      withReferenceImageMock(async (url) => {
        if (url.includes(":predictLongRunning")) return jsonResponse({ name: "operations/op-slow" });
        if (url.includes("operations/op-slow")) return jsonResponse({ name: "operations/op-slow", done: false });
        throw new Error("no debería llegar más lejos");
      }),
    );
    try {
      await assert.rejects(
        () => veoVideoProvider.generateVideo(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "timeout" && err.providerJobId === "operations/op-slow",
      );
    } finally {
      restore();
    }
  });
});

test("fallo de descarga (HTTP no-200 al bajar el video) se normaliza a download_failed y conserva el operationId (video ya generado, ya facturado)", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    const restore = installFetchMock(
      withReferenceImageMock(async (url) => {
        if (url.includes(":predictLongRunning")) return jsonResponse({ name: "operations/op-dl" });
        if (url.includes("operations/op-dl")) return jsonResponse(COMPLETED_OPERATION("operations/op-dl", "https://files.example.com/gone.mp4"));
        if (url.includes("files.example.com")) return new Response("not found", { status: 404 });
        throw new Error("no debería llegar más lejos");
      }),
    );
    try {
      await assert.rejects(
        () => veoVideoProvider.generateVideo(BASE_REQUEST),
        (err: unknown) => err instanceof GenerativeProviderError && err.reason === "download_failed" && err.providerJobId === "operations/op-dl",
      );
    } finally {
      restore();
    }
  });
});

test("nunca se llama la red real: todos los tests de este archivo usan fetch simulado y ningún host real aparece en las URLs capturadas", async () => {
  await withEnv({ VEO_API_KEY: "fake-key" }, async () => {
    const calledUrls: string[] = [];
    const restore = installFetchMock(
      withReferenceImageMock(async (url) => {
        calledUrls.push(url);
        if (url.includes(":predictLongRunning")) return jsonResponse({ name: "operations/op-3" });
        if (url.includes("operations/op-3")) return jsonResponse(COMPLETED_OPERATION("operations/op-3", "https://files.example.com/out3.mp4"));
        return new Response(Buffer.from("bytes"), { status: 200 });
      }),
    );
    try {
      await veoVideoProvider.generateVideo(BASE_REQUEST);
      for (const url of calledUrls) {
        assert.ok(url.includes("generativelanguage.googleapis.com") || url.includes("files.example.com"), `URL inesperada: ${url}`);
      }
      assert.ok(calledUrls.length > 0);
    } finally {
      restore();
    }
  });
});
