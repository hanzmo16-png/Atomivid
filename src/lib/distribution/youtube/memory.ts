/**
 * Distribution Memory V1: OBSERVES, per channel. Every read and write requires a
 * channelId, so one channel's data can never leak into another. No function here
 * recommends topics, titles or thumbnails; correlation is not causation.
 */
import type { MetricRow } from "./analytics";

export type VideoObservation = {
  channelId: string;
  videoId: string;
  publishedAt: string | null;
  topic: string | null;
  titleStructure: string | null;
  thumbnailMetadata: Record<string, string> | null;
  durationSeconds: number | null;
  hookStructure: string | null;
};

export class ChannelIsolationError extends Error {}

export class DistributionMemory {
  private readonly byChannel = new Map<string, { videos: Map<string, VideoObservation>; metrics: Map<string, MetricRow> }>();

  private bucket(channelId: string) {
    if (!channelId) throw new ChannelIsolationError("channelId is required");
    let b = this.byChannel.get(channelId);
    if (!b) { b = { videos: new Map(), metrics: new Map() }; this.byChannel.set(channelId, b); }
    return b;
  }

  observeVideo(channelId: string, v: VideoObservation): void {
    if (v.channelId !== channelId) throw new ChannelIsolationError(`video ${v.videoId} belongs to ${v.channelId}, not ${channelId}`);
    this.bucket(channelId).videos.set(v.videoId, { ...v });
  }

  observeMetrics(channelId: string, rows: MetricRow[]): void {
    const b = this.bucket(channelId);
    for (const r of rows) {
      if (r.channelId !== channelId) throw new ChannelIsolationError(`metric row for ${r.channelId} rejected in ${channelId}`);
      b.metrics.set(r.rowKey, { ...r });
    }
  }

  videos(channelId: string): VideoObservation[] {
    return [...this.bucket(channelId).videos.values()];
  }

  metrics(channelId: string, videoId?: string): MetricRow[] {
    return [...this.bucket(channelId).metrics.values()].filter((m) => !videoId || m.videoId === videoId);
  }

  /** Descriptive summary only (no ranking, no recommendation). */
  describe(channelId: string): { videos: number; metricRows: number; note: string } {
    const b = this.bucket(channelId);
    return { videos: b.videos.size, metricRows: b.metrics.size, note: "observational data; correlations are not causal and drive no automatic decision" };
  }
}
