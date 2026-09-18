/**
 * Prueba directa (sin Remotion, sin llamada real) de que el resolver
 * visual (visual-resource-resolver.ts) genera una imagen con el
 * proveedor fixture Y la reutiliza idempotentemente (costo $0 el
 * segundo intento) — complementa scripts/dry-run-visual-plan.ts, que
 * solo imprime la DECISIÓN del planificador sin ejecutar el I/O real de
 * generación/subida.
 *
 * Nota honesta: el storyboard *simulado* (storyboard/simulate.ts, usado
 * sin ANTHROPIC_API_KEY) siempre clasifica las escenas como
 * "stock_video" — sin una llamada real a Claude, nunca se arma un
 * storyboard con una escena de tipo "imagen" de verdad, así que este
 * script construye una escena de imagen A MANO para poder ejercer el
 * camino de generación del resolver end-to-end sin gastar nada. La
 * DECISIÓN del planificador (decideResourceStrategy) en sí ya está
 * cubierta por visual-resource-planner.test.ts.
 *
 * Uso: npx tsx scripts/dry-run-visual-mix.ts
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

process.env.IMAGE_PROVIDER = "fixture";

async function main() {
  const { resolveGeneratedImageForScene, findExistingGeneratedImage } = await import("../src/lib/video/visual-resource-resolver");
  const { getImageProvider } = await import("../src/lib/providers/image");
  const imageProvider = getImageProvider();
  console.log("Proveedor de imagen resuelto:", imageProvider.name);

  const imageScene = {
    sceneIndex: 0,
    narrationText: "Una montaña al amanecer, símbolo de un nuevo comienzo.",
    resourceType: "image" as const,
    imagePrompt: "sunrise over a mountain, cinematic, vertical",
    negativePrompt: "text, watermark",
  };

  // Mock mínimo de Supabase Storage — I/O real contra el proveedor fixture
  // de imagen, almacenamiento simulado en memoria.
  const files = new Map<string, Buffer>();
  const fakeSupabase = {
    storage: {
      from() {
        return {
          async list(dir: string, opts: { search: string }) {
            const matches = Array.from(files.keys())
              .filter((k) => k.startsWith(`${dir}/`) && k.includes(opts.search))
              .map((k) => ({ name: k.split("/").pop()! }));
            return { data: matches, error: null };
          },
          async upload(objectPath: string, buffer: Buffer) {
            files.set(objectPath, buffer);
            return { error: null };
          },
          async createSignedUrl(objectPath: string) {
            return { data: { signedUrl: `https://fake.local/${objectPath}` }, error: null };
          },
        };
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const generated = await resolveGeneratedImageForScene({
    supabase: fakeSupabase,
    bucket: "visuals",
    requestId: "r-mix",
    sceneIndex: 0,
    scene: imageScene as never,
    imageProvider,
    remainingBudgetUsd: 1,
    signedUrlTtlSeconds: 60,
  });
  console.log("1) Imagen generada (fixture):", JSON.stringify({ ...generated, url: "[firmada, omitida]" }));

  const reused = await resolveGeneratedImageForScene({
    supabase: fakeSupabase,
    bucket: "visuals",
    requestId: "r-mix",
    sceneIndex: 0,
    scene: imageScene as never,
    imageProvider,
    remainingBudgetUsd: 1,
    signedUrlTtlSeconds: 60,
  });
  console.log("2) Reintento de la misma escena (idempotencia):", JSON.stringify({ status: reused.status, costUsd: reused.costUsd }));
  if (reused.status !== "reused" || reused.costUsd !== 0) {
    throw new Error("La idempotencia del recurso generado falló");
  }

  const existing = await findExistingGeneratedImage(fakeSupabase, "visuals", "r-mix", 0);
  console.log("3) Archivo generado persistido:", JSON.stringify(existing));
  console.log(
    "\nMezcla imagen-generada + stock: la escena 0 usó el proveedor de imagen (fixture, $0); cualquier otra escena de una solicitud " +
      "real que NO sea candidata a generación usa stock directamente, sin llamar a este resolver en absoluto — ver visual-resource-planner.ts.",
  );
}

main().catch((err) => {
  console.error("Falló la prueba de mezcla visual:", err);
  process.exit(1);
});
