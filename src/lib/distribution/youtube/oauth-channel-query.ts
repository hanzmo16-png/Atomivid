/**
 * READ-ONLY channel identification for the OAuth connect flow: the `channels.list mine=true`
 * request and the minimal shape of its answer (channel id + title). Nothing else: no
 * snapshots, no analytics, no playlists, no mutation. Pure URL building and types, so the
 * OAuth routes do not depend on the monitoring layer or on Production Intelligence.
 */
export const DATA_CHANNELS_URL = "https://www.googleapis.com/youtube/v3/channels";

/** The authenticated account's own channel(s): id and snippet (title). Requires youtube.readonly only. */
export const channelQuery = () => `${DATA_CHANNELS_URL}?${new URLSearchParams({ part: "snippet", mine: "true" })}`;

export type ChannelListResponse = { items?: { id: string; snippet?: { title?: string } }[] };
