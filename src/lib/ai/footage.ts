const PEXELS_API_KEY = process.env.PEXELS_API_KEY;

type PexelsVideoFile = {
  link: string;
  width: number | null;
  height: number | null;
  file_type: string;
  quality: string;
};

type PexelsVideo = {
  duration: number;
  user?: { name?: string };
  video_files: PexelsVideoFile[];
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

export async function fetchSceneVideo(
  query: string,
  minimumDurationSeconds = 0,
): Promise<{ url: string; photographer?: string } | null> {
  if (!PEXELS_API_KEY) {
    throw new Error("Falta configurar PEXELS_API_KEY");
  }

  const params = new URLSearchParams({
    query,
    orientation: "portrait",
    per_page: "5",
    size: "medium",
  });

  const res = await fetch(`https://api.pexels.com/videos/search?${params}`, {
    headers: { Authorization: PEXELS_API_KEY },
  });

  if (!res.ok) {
    throw new Error(`Pexels Videos respondió ${res.status}`);
  }

  const data = (await res.json()) as { videos: PexelsVideo[] };
  for (const video of data.videos) {
    if (video.duration < minimumDurationSeconds) continue;
    const file = selectPortraitVideoFile(video.video_files);
    if (file) {
      return { url: file.link, photographer: video.user?.name };
    }
  }

  return null;
}

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
