import { downloadImage, fetchSceneImage, fetchSceneVideo } from "@/lib/ai/footage";
import type { FootageProvider } from "../types";

export const realFootageProvider: FootageProvider = {
  name: "pexels-video-first",
  async fetchFootage(query, minimumDurationSeconds) {
    // Si el catálogo de video falla temporalmente, una fotografía sigue
    // permitiendo terminar el reel en vez de perder todo el render.
    const video = await fetchSceneVideo(query, minimumDurationSeconds).catch((error) => {
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

    const result = await fetchSceneImage(query);
    return {
      ...result,
      mediaType: "image" as const,
      mimeType: "image/jpeg",
      extension: "jpg",
    };
  },
  downloadFootage: downloadImage,
};
