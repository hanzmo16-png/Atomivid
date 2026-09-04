import type { MusicProvider } from "../types";
import { customUrlMusicProvider } from "./real";
import { fixtureMusicProvider } from "./fixture";
import { MUSIC_MANIFEST } from "./manifest";

export function getMusicProvider(): MusicProvider {
  if (process.env.MUSIC_PROVIDER === "fixture") return fixtureMusicProvider;
  if (process.env.MUSIC_PROVIDER === "custom") return customUrlMusicProvider;
  const hasRealTracks =
    MUSIC_MANIFEST.length > 0 || Boolean(process.env.MUSIC_TRACK_URL) ||
    Boolean(process.env.MUSIC_TRACK_URLS);
  return hasRealTracks ? customUrlMusicProvider : fixtureMusicProvider;
}

export type { MusicProvider, MusicResult } from "../types";
