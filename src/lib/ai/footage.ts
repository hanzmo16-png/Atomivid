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
  user?: { name?: string };
  video_files: PexelsVideoFile[];
};

export type FootageCandidateRaw = {
  url: string;
  sourceId: string;
  photographer?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
};

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

/**
 * Trae TODOS los candidatos de video que cumplen el mínimo de duración y
 * tienen un archivo vertical aprovechable — no solo el primero. El
 * selector (src/lib/video/footage-select.ts) es quien decide cuál usar,
 * comparando entre varias consultas y contra lo ya usado en el video.
 */
export async function searchSceneVideos(
  query: string,
  minimumDurationSeconds = 0,
): Promise<FootageCandidateRaw[]> {
  if (!PEXELS_API_KEY) {
    throw new Error("Falta configurar PEXELS_API_KEY");
  }

  const params = new URLSearchParams({
    query,
    orientation: "portrait",
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
    const file = selectPortraitVideoFile(video.video_files);
    if (!file) continue;
    candidates.push({
      url: file.link,
      sourceId: `pexels-video-${video.id}`,
      photographer: video.user?.name,
      width: file.width ?? undefined,
      height: file.height ?? undefined,
      durationSeconds: video.duration,
    });
  }

  return candidates;
}

export async function fetchSceneVideo(
  query: string,
  minimumDurationSeconds = 0,
): Promise<{ url: string; photographer?: string } | null> {
  const candidates = await searchSceneVideos(query, minimumDurationSeconds);
  const first = candidates[0];
  return first ? { url: first.url, photographer: first.photographer } : null;
}

/** Igual que searchSceneVideos pero para fotos — último recurso cuando ningún concepto encuentra video. */
export async function searchScenePhotos(query: string): Promise<FootageCandidateRaw[]> {
  if (!PEXELS_API_KEY) {
    throw new Error("Falta configurar PEXELS_API_KEY");
  }

  const params = new URLSearchParams({
    query,
    orientation: "portrait",
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
    }[];
  };

  return data.photos.map((photo) => ({
    url: photo.src.large2x,
    sourceId: `pexels-photo-${photo.id}`,
    photographer: photo.photographer,
    width: photo.width,
    height: photo.height,
  }));
}

export async function fetchSceneImage(
  query: string,
): Promise<{ url: string; photographer: string }> {
  const candidates = await searchScenePhotos(query);
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
