const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

type PexelsVideoFile = {
  link: string;
  width: number | null;
  height: number | null;
  file_type: string;
  quality: string;
};

type PexelsVideo = {
  id: number;
  duration: number;
  /** Página pública del video; su slug describe el contenido (p. ej. ".../video/aerial-view-of-a-ship-3571264/"). */
  url?: string;
  user?: { name?: string };
  video_files: PexelsVideoFile[];
};

/** "portrait" (default histórico, Reel/Avatar 9:16) | "landscape" (Long Form 16:9). */
export type FootageOrientation = "portrait" | "landscape";

export type FootageCandidateRaw = {
  url: string;
  sourceId: string;
  photographer?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  /** Texto descriptivo del proveedor (alt de la foto / slug de la página del video) — insumo de pertinencia por palabras clave, no una validación semántica. */
  description?: string;
  /** Página pública del recurso (atribución/procedencia). */
  pageUrl?: string;
};

/** "aerial-view-of-a-ship-3571264" → "aerial view of a ship". */
export function describeFromPexelsPageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const slug = url.replace(/\/+$/, "").split("/").pop() ?? "";
  const words = slug.split("-").filter((w) => w && !/^\d+$/.test(w));
  return words.length > 0 ? words.join(" ") : undefined;
}

/**
 * Elige un MP4 vertical suficientemente nítido sin descargar el original
 * más pesado. Favorece 1080x1920 y después 720x1280.
 */
export function selectPortraitVideoFile(files: PexelsVideoFile[]): PexelsVideoFile | null {
  const candidates = files.filter(
    (file) =>
      file.file_type === "video/mp4" &&
      typeof file.width === "number" &&
      typeof file.height === "number" &&
      file.height > file.width &&
      file.width >= 720,
  );

  return (
    candidates.sort((a, b) => {
      const aDistance = Math.abs((a.width ?? 0) - 1080);
      const bDistance = Math.abs((b.width ?? 0) - 1080);
      return aDistance - bDistance;
    })[0] ?? null
  );
}

/** Igual que selectPortraitVideoFile pero para 16:9 — favorece 1920x1080 y después 1280x720. */
export function selectLandscapeVideoFile(files: PexelsVideoFile[]): PexelsVideoFile | null {
  const candidates = files.filter(
    (file) =>
      file.file_type === "video/mp4" &&
      typeof file.width === "number" &&
      typeof file.height === "number" &&
      file.width > file.height &&
      file.width >= 1280,
  );
  return candidates.sort((a, b) => Math.abs((a.width ?? 0) - 1920) - Math.abs((b.width ?? 0) - 1920))[0] ?? null;
}

/**
 * Trae TODOS los candidatos de video que cumplen el mínimo de duración y
 * tienen un archivo vertical aprovechable — no solo el primero. El
 * selector (src/lib/video/footage-select.ts) es quien decide cuál usar,
 * comparando entre varias consultas y contra lo ya usado en el video.
 */
export async function searchSceneVideos(
  query: string,
  minimumDurationSeconds = 0,
  orientation: FootageOrientation = "portrait",
): Promise<FootageCandidateRaw[]> {
  if (!PEXELS_API_KEY) {
    throw new Error("Falta configurar PEXELS_API_KEY");
  }

  const params = new URLSearchParams({
    query,
    orientation,
    per_page: "12",
    size: "medium",
  });

  const res = await fetch(`https://api.pexels.com/videos/search?${params}`, {
    headers: { Authorization: PEXELS_API_KEY },
  });

  if (!res.ok) {
    throw new Error(`Pexels Videos respondió ${res.status}`);
  }

  const data = (await res.json()) as { videos: PexelsVideo[] };
  const candidates: FootageCandidateRaw[] = [];

  for (const video of data.videos) {
    if (video.duration < minimumDurationSeconds) continue;
    const file = orientation === "landscape" ? selectLandscapeVideoFile(video.video_files) : selectPortraitVideoFile(video.video_files);
    if (!file) continue;
    candidates.push({
      url: file.link,
      sourceId: `pexels-video-${video.id}`,
      photographer: video.user?.name,
      width: file.width ?? undefined,
      height: file.height ?? undefined,
      durationSeconds: video.duration,
      description: describeFromPexelsPageUrl(video.url),
      pageUrl: video.url,
    });
  }

  return candidates;
}

export async function fetchSceneVideo(
  query: string,
  minimumDurationSeconds = 0,
  orientation: FootageOrientation = "portrait",
): Promise<{ url: string; photographer?: string } | null> {
  const candidates = await searchSceneVideos(query, minimumDurationSeconds, orientation);
  const first = candidates[0];
  return first ? { url: first.url, photographer: first.photographer } : null;
}

/** Igual que searchSceneVideos pero para fotos — último recurso cuando ningún concepto encuentra video. */
export async function searchScenePhotos(query: string, orientation: FootageOrientation = "portrait"): Promise<FootageCandidateRaw[]> {
  if (!PEXELS_API_KEY) {
    throw new Error("Falta configurar PEXELS_API_KEY");
  }

  const params = new URLSearchParams({
    query,
    orientation,
    per_page: "8",
  });

  const res = await fetch(`https://api.pexels.com/v1/search?${params}`, {
    headers: { Authorization: PEXELS_API_KEY },
  });

  if (!res.ok) {
    throw new Error(`Pexels respondió ${res.status}`);
  }

  const data = (await res.json()) as {
    photos: {
      id: number;
      width: number;
      height: number;
      src: { large2x: string };
      photographer: string;
      alt?: string;
      url?: string;
    }[];
  };

  return data.photos.map((photo) => ({
    url: photo.src.large2x,
    sourceId: `pexels-photo-${photo.id}`,
    photographer: photo.photographer,
    width: photo.width,
    height: photo.height,
    description: photo.alt?.trim() || describeFromPexelsPageUrl(photo.url),
    pageUrl: photo.url,
  }));
}

export async function fetchSceneImage(
  query: string,
  orientation: FootageOrientation = "portrait",
): Promise<{ url: string; photographer: string }> {
  const candidates = await searchScenePhotos(query, orientation);
  const photo = candidates[0];
  if (!photo) {
    throw new Error(`Pexels no encontró resultados para "${query}"`);
  }
  return { url: photo.url, photographer: photo.photographer ?? "" };
}

export async function downloadImage(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`No se pudo descargar la imagen: ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
