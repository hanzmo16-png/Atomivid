import {
  downloadImage,
  fetchSceneImage,
  fetchSceneVideo,
  searchSceneVideos,
  searchScenePhotos,
} from "@/lib/ai/footage";
import type { FootageCandidate, FootageProvider } from "../types";

export const realFootageProvider: FootageProvider = {
  name: "pexels-video-first",
  async fetchFootage(query, minimumDurationSeconds, orientation = "portrait") {
    // Si el catálogo de video falla temporalmente, una fotografía sigue
    // permitiendo terminar el reel en vez de perder todo el render.
    const video = await fetchSceneVideo(query, minimumDurationSeconds, orientation).catch((error) => {
      console.warn(`Pexels Videos falló para "${query}"; se usará una foto:`, error);
      return null;
    });
    if (video) {
      return {
        ...video,
        mediaType: "video" as const,
        mimeType: "video/mp4",
        extension: "mp4",
      };
    }

    const result = await fetchSceneImage(query, orientation);
    return {
      ...result,
      mediaType: "image" as const,
      mimeType: "image/jpeg",
      extension: "jpg",
    };
  },
  downloadFootage: downloadImage,
  async searchVideoCandidates(query, minimumDurationSeconds, orientation = "portrait"): Promise<FootageCandidate[]> {
    const raw = await searchSceneVideos(query, minimumDurationSeconds, orientation);
    return raw.map((c) => ({
      url: c.url,
      sourceId: c.sourceId,
      photographer: c.photographer,
      width: c.width,
      height: c.height,
      durationSeconds: c.durationSeconds,
      mediaType: "video" as const,
      mimeType: "video/mp4",
      extension: "mp4",
    }));
  },
  async searchImageCandidates(query, orientation = "portrait"): Promise<FootageCandidate[]> {
    const raw = await searchScenePhotos(query, orientation);
    return raw.map((c) => ({
      url: c.url,
      sourceId: c.sourceId,
      photographer: c.photographer,
      width: c.width,
      height: c.height,
      mediaType: "image" as const,
      mimeType: "image/jpeg",
      extension: "jpg",
    }));
  },
};
