import type { MusicProvider } from "../types";
import { curatedLibraryMusicProvider } from "./real";
import { fixtureMusicProvider } from "./fixture";
import { MUSIC_MANIFEST } from "./manifest";

export function getMusicProvider(): MusicProvider {
  if (process.env.MUSIC_PROVIDER === "fixture") return fixtureMusicProvider;
  // "custom" se mantiene como alias retrocompatible del nombre anterior
  // del proveedor curado (antes "custom-url").
  if (process.env.MUSIC_PROVIDER === "custom" || process.env.MUSIC_PROVIDER === "curated-library") {
    return curatedLibraryMusicProvider;
  }
  const hasRealTracks =
    MUSIC_MANIFEST.length > 0 || Boolean(process.env.MUSIC_TRACK_URL) ||
    Boolean(process.env.MUSIC_TRACK_URLS);
  return hasRealTracks ? curatedLibraryMusicProvider : fixtureMusicProvider;
}

export type { MusicProvider, MusicResult, MusicTone, MusicSelectionContext } from "../types";
