import type { MusicProvider } from "../types";
import { customUrlMusicProvider } from "./real";
import { fixtureMusicProvider } from "./fixture";

export function getMusicProvider(): MusicProvider {
  if (process.env.MUSIC_PROVIDER === "fixture") return fixtureMusicProvider;
  if (process.env.MUSIC_PROVIDER === "custom") return customUrlMusicProvider;
  return process.env.MUSIC_TRACK_URL || process.env.MUSIC_TRACK_URLS
    ? customUrlMusicProvider
    : fixtureMusicProvider;
}

export type { MusicProvider, MusicResult } from "../types";
