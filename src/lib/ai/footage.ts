const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

export async function fetchSceneImage(
  query: string,
): Promise<{ url: string; photographer: string }> {
  if (!PEXELS_API_KEY) {
    throw new Error("Falta configurar PEXELS_API_KEY");
  }

  const params = new URLSearchParams({
    query,
    orientation: "portrait",
    per_page: "1",
  });

  const res = await fetch(`https://api.pexels.com/v1/search?${params}`, {
    headers: { Authorization: PEXELS_API_KEY },
  });

  if (!res.ok) {
    throw new Error(`Pexels respondió ${res.status}`);
  }

  const data = (await res.json()) as {
    photos: { src: { large2x: string }; photographer: string }[];
  };

  const photo = data.photos[0];
  if (!photo) {
    throw new Error(`Pexels no encontró resultados para "${query}"`);
  }

  return { url: photo.src.large2x, photographer: photo.photographer };
}

export async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`No se pudo descargar la imagen: ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
