import { downloadImage, fetchSceneImage } from "@/lib/ai/footage";
import type { FootageProvider } from "../types";

export const realFootageProvider: FootageProvider = {
  name: "pexels",
  async fetchImage(query) {
    const result = await fetchSceneImage(query);
    return { ...result, mimeType: "image/jpeg", extension: "jpg" };
  },
  downloadImage,
};
