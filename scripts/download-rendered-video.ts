/**
 * Verificación de un solo uso: descarga el video final ya generado para
 * una solicitud (a partir de su video_path en la base de datos) y lo deja
 * en disco como verify-output.mp4, para que el workflow lo suba como
 * artifact de GitHub Actions y así se pueda validar con ffprobe fuera de
 * este entorno (Supabase no es alcanzable desde el sandbox de
 * desarrollo).
 *
 * Uso: REQUEST_ID=<uuid> npx tsx scripts/download-rendered-video.ts
 */
export {};

async function main() {
  const requestId = process.env.REQUEST_ID;
  if (!requestId) throw new Error("REQUEST_ID no está definido");

  const { createServiceClient } = await import("../src/lib/supabase/service");
  const { getSignedVideoUrl } = await import("../src/lib/storage/signed-url");
  const service = createServiceClient();

  const { data: row, error } = await service
    .from("video_requests")
    .select("status, video_path")
    .eq("id", requestId)
    .single<{ status: string; video_path: string | null }>();

  if (error || !row) throw new Error(`No se encontró la solicitud: ${error?.message}`);
  if (row.status !== "completed" || !row.video_path) {
    throw new Error(`La solicitud no está completed o no tiene video_path (status=${row.status})`);
  }

  const url = await getSignedVideoUrl(row.video_path, 300);
  if (!url) throw new Error("No se pudo firmar la URL del video");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`No se pudo descargar el video: HTTP ${res.status}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  const fs = await import("node:fs/promises");
  await fs.writeFile("verify-output.mp4", buffer);
  console.log(`Video descargado: ${buffer.length} bytes → verify-output.mp4`);
}

main().catch((err) => {
  console.error("Fallo al descargar el video para verificar:", err);
  process.exit(1);
});
