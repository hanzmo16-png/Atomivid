/**
 * Firma una URL de lectura temporal para el `final.mp4` de una solicitud
 * YA renderizada, y la verifica con una petición HTTP real antes de
 * imprimirla. De solo lectura: no genera guion, no sintetiza voz, no
 * busca footage, no renderiza con Remotion, no toca la cuota del usuario
 * ni ningún proveedor de IA — únicamente pide a Supabase Storage una URL
 * firmada para un objeto que ya existe en el bucket privado "videos".
 *
 * Uso: REQUEST_ID=<uuid> [EXPIRES_IN_SECONDS=7200] npx tsx scripts/get-signed-url.ts
 */
export {}; // Fuerza scope de módulo — evita colisionar con `main()` de otros scripts.

async function main() {
  const requestId = process.env.REQUEST_ID;
  if (!requestId) {
    throw new Error("REQUEST_ID no está definido");
  }
  const expiresInSeconds = Number(process.env.EXPIRES_IN_SECONDS ?? "7200");

  const { createServiceClient } = await import("../src/lib/supabase/service");
  const service = createServiceClient();
  const objectPath = `${requestId}/final.mp4`;

  const { data, error } = await service.storage
    .from("videos")
    .createSignedUrl(objectPath, expiresInSeconds);

  if (error || !data) {
    throw new Error(`No se pudo firmar ${objectPath}: ${error?.message ?? "desconocido"}`);
  }

  const url = data.signedUrl;

  const res = await fetch(url);
  const contentType = res.headers.get("content-type") ?? "";
  const contentLength = Number(res.headers.get("content-length") ?? "0");

  if (!res.ok) {
    throw new Error(
      `La URL firmada respondió HTTP ${res.status} en vez de 200 (objectPath=${objectPath})`,
    );
  }
  if (!contentType.includes("video/mp4")) {
    throw new Error(`content-type inesperado: "${contentType}" (se esperaba video/mp4)`);
  }
  if (!(contentLength > 0)) {
    throw new Error(`content-length inválido: ${contentLength}`);
  }

  console.log(
    `[atomivid:signed-url] verificación OK — objectPath=${objectPath} status=${res.status} ` +
      `contentType=${contentType} contentLength=${contentLength} expiresInSeconds=${expiresInSeconds}`,
  );
  console.log("[atomivid:signed-url] SIGNED_URL_START");
  console.log(url);
  console.log("[atomivid:signed-url] SIGNED_URL_END");
}

main().catch((err) => {
  console.error("No se pudo generar/verificar la URL firmada:", err);
  process.exit(1);
});
