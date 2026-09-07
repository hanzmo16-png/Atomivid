/**
 * Prueba de un solo uso: genera un guion real con Claude (no el proveedor
 * fixture) para confirmar que la integración funciona con credenciales
 * reales, y ejercita también regenerateScene (el flujo del editor de
 * guion). Corre dentro de GitHub Actions, que sí tiene salida de red hacia
 * la API de Anthropic — este entorno de desarrollo no.
 *
 * Uso: npx tsx scripts/test-real-script.ts
 */
export {};

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY no está definido — esta prueba requiere el proveedor real");
  }

  const { getScriptProvider } = await import("../src/lib/providers/script");
  const provider = getScriptProvider();
  if (provider.name !== "anthropic") {
    throw new Error(`Se esperaba el proveedor "anthropic", se obtuvo "${provider.name}"`);
  }

  const topic = "Por qué el hábito de leer 10 minutos al día cambia tu cerebro";
  const style = "Educativo, motivacional";
  const durationSeconds = 30;

  console.log("Generando guion real con Claude...");
  const script = await provider.generateScript({ topic, style, durationSeconds });
  console.log(`Título: "${script.title}"`);
  console.log(`Escenas: ${script.segments.length}`);
  script.segments.forEach((s, i) => {
    console.log(`  [${i}] (${s.visualQuery}) ${s.text}`);
  });

  console.log("\nRegenerando la escena 0...");
  const newScene = await provider.regenerateScene({ topic, style, script, sceneIndex: 0 });
  console.log(`  [0 regenerada] (${newScene.visualQuery}) ${newScene.text}`);

  console.log("\nOK: generación real de guion con Claude funciona correctamente.");
}

main().catch((err) => {
  console.error("Fallo la prueba de guion real:", err);
  process.exit(1);
});
