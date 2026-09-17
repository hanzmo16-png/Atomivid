/**
 * Descarga el `final.mp4` YA renderizado de una solicitud existente
 * directamente desde el bucket privado "videos" y lo deja en disco para
 * que el workflow lo suba como artifact. De solo lectura: no genera
 * guion, no sintetiza voz, no busca footage, no renderiza con Remotion y
 * no toca la cuota de ningún usuario.
 *
 * Deliberadamente NO usa createSignedUrl(): imprimir esa URL en el log de
 * GitHub Actions provoca que el token quede enmascarado como "***" (el
 * runner también enmascara los segmentos internos de cualquier JWT que
 * coincida con los de un secret registrado — el header estándar de un
 * JWT firmado con el mismo algoritmo es idéntico entre tokens distintos,
 * así que no se puede confirmar con certeza si eso era una falsa alarma
 * o una colisión real con SUPABASE_SERVICE_ROLE_KEY). En vez de forzar
 * esa cadena a través del enmascarado, se descargan los bytes del archivo
 * con el cliente service-role (igual que hace generate-video.ts al leer
 * assets intermedios) y se entregan como artifact binario.
 *
 * Uso: REQUEST_ID=<uuid> npx tsx scripts/export-final-video.ts
 */
import { writeFile } from "node:fs/promises";

export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

async function main() {
  const requestId = process.env.REQUEST_ID;
  if (!requestId) {
    throw new Error("REQUEST_ID no está definido");
  }

  const { createServiceClient } = await import("../src/lib/supabase/service");
  const service = createServiceClient();
  const objectPath = `${requestId}/final.mp4`;

  const { data, error } = await service.storage.from("videos").download(objectPath);

  if (error || !data) {
    throw new Error(`No se pudo descargar ${objectPath}: ${error?.message ?? "desconocido"}`);
  }

  const buffer = Buffer.from(await data.arrayBuffer());
  if (buffer.byteLength === 0) {
    throw new Error(`${objectPath} se descargó con tamaño 0`);
  }

  const outPath = `final-${requestId}.mp4`;
  await writeFile(outPath, buffer);

  console.log(
    `[atomivid:export-video] objectPath=${objectPath} bytes=${buffer.byteLength} outPath=${outPath}`,
  );
}

main().catch((err) => {
  console.error("No se pudo exportar el video existente:", err);
  process.exit(1);
});
