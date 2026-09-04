import type { MusicProvider } from "../types";
import { customUrlMusicProvider } from "./real";
import { fixtureMusicProvider } from "./fixture";

export function getMusicProvider(): MusicProvider {
  if (process.env.MUSIC_PROVIDER === "fixture") return fixtureMusicProvider;
  if (process.env.MUSIC_PROVIDER === "custom") return customUrlMusicProvider;
  return process.env.MUSIC_TRACK_URL ? customUrlMusicProvider : fixtureMusicProvider;
}

export type { MusicProvider, MusicResult } from "../types";
