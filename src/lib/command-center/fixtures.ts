/**
 * Deterministic in-memory scenarios for tests and the visual QA harness ONLY (never imported
 * by app code): rich data, empty database, migrations not applied, partial data, service down.
 */
import type { MemoryData } from "./sources";

export const NOW = "2026-10-30T12:00:00.000Z";
const CH = "UCaaaaaaaaaaaaaaaaaaaaaa";

export const RICH: MemoryData = {
  users: { total: 42, rows: [{ id: "a", createdAt: "2026-10-29T00:00:00Z", lastSignInAt: "2026-10-30T09:00:00Z" }, { id: "b", createdAt: "2026-09-01T00:00:00Z", lastSignInAt: "2026-10-25T00:00:00Z" }] },
  subscriptions: [{ userId: "a", status: "active", priceId: "price_pro", createdAt: "2026-10-01T00:00:00Z" }],
  requests: [
    { id: "r1", userId: "a", mode: "visual", status: "completed", createdAt: "2026-10-30T08:00:00Z", renderAttempts: 1, renderStartedAt: null, longFormStage: null },
    { id: "r2", userId: "b", mode: "long_form", status: "processing", createdAt: "2026-10-29T08:00:00Z", renderAttempts: 1, renderStartedAt: "2026-10-30T11:30:00Z", longFormStage: "rendering" },
    { id: "r3", userId: "b", mode: "avatar", status: "completed", createdAt: "2026-10-27T08:00:00Z", renderAttempts: 1, renderStartedAt: null, longFormStage: null },
    { id: "r4", userId: "a", mode: "long_form", status: "completed", createdAt: "2026-10-26T08:00:00Z", renderAttempts: 2, renderStartedAt: null, longFormStage: null },
  ],
  costs: [{ requestId: "r1", estimatedCostUsd: 1, imageProvider: "openai", imageCostUsd: 0.4, premiumVideoProvider: "runway", premiumVideoCostUsd: 0.5, avatarCostUsd: 0, voiceProvider: "elevenlabs", footageProvider: "pexels", renderMs: 60000, regenerations: 0 }, { requestId: "r4", estimatedCostUsd: 30, imageProvider: "openai", imageCostUsd: 3, premiumVideoProvider: "runway", premiumVideoCostUsd: 2, avatarCostUsd: 0, voiceProvider: "elevenlabs", footageProvider: null, renderMs: 180000, regenerations: 1 }],
  paidOps: [{ projectId: "r4", provider: "runway", method: "I2V_ECONOMY", reservedUsd: 0.25, committedUsd: 0.25, status: "COMMITTED", updatedAt: "2026-10-26T09:00:00Z" }],
  capacity: [{ provider: "elevenlabs", unit: "character", available: 20000, reserved: 1000, pending: 0, status: "GREEN", reliability: "provider_api", renewalDate: "2026-11-15", checkedAt: "2026-10-30T10:00:00Z" }, { provider: "openai", unit: "usd", available: null, reserved: 2, pending: 0, status: "GREEN", reliability: "derived_from_ledger", renewalDate: null, checkedAt: "2026-10-30T10:00:00Z" }, { provider: "runway", unit: "usd", available: 18, reserved: 5, pending: 0, status: "GREEN", reliability: "provider_api", renewalDate: null, checkedAt: "2026-10-30T10:00:00Z" }],
  finalCut: [{ productionId: "r4", masterId: "m4", toState: "EDITORIAL_INSPECTING", decidedAt: "2026-10-27T00:00:00Z" }, { productionId: "r4", masterId: "m4", toState: "EDITORIAL_QA_PASS", decidedAt: "2026-10-27T00:01:00Z" }],
  ytChannels: [{ channelId: CH, status: "connected", title: "The Iron Annals" }],
  ytLinks: [{ projectId: "r4", channelId: CH, videoId: "dQw4w9WgXcQ", publishedAt: "2026-10-22T00:00:00Z" }],
  ytRows: [
    { channelId: CH, videoId: "dQw4w9WgXcQ", metric: "views", value: 1240, dimensionLabel: null, dimensionValue: null, windowStart: "2026-10-22", windowEnd: "2026-10-29", source: "youtube-analytics-v2", collectedAt: "2026-10-29T12:00:00Z" },
    { channelId: CH, videoId: "dQw4w9WgXcQ", metric: "watchTimeMinutes", value: 4310, dimensionLabel: null, dimensionValue: null, windowStart: "2026-10-22", windowEnd: "2026-10-29", source: "youtube-analytics-v2", collectedAt: "2026-10-29T12:00:00Z" },
    { channelId: CH, videoId: "dQw4w9WgXcQ", metric: "averageViewDurationSeconds", value: 208, dimensionLabel: null, dimensionValue: null, windowStart: "2026-10-22", windowEnd: "2026-10-29", source: "youtube-analytics-v2", collectedAt: "2026-10-29T12:00:00Z" },
    { channelId: CH, videoId: "dQw4w9WgXcQ", metric: "averagePercentageViewed", value: 41.3, dimensionLabel: null, dimensionValue: null, windowStart: "2026-10-22", windowEnd: "2026-10-29", source: "youtube-analytics-v2", collectedAt: "2026-10-29T12:00:00Z" },
    { channelId: CH, videoId: "dQw4w9WgXcQ", metric: "subscribersGained", value: 12, dimensionLabel: null, dimensionValue: null, windowStart: "2026-10-22", windowEnd: "2026-10-29", source: "youtube-analytics-v2", collectedAt: "2026-10-29T12:00:00Z" },
    { channelId: CH, videoId: "dQw4w9WgXcQ", metric: "views", value: 800, dimensionLabel: "YT_SEARCH", dimensionValue: null, windowStart: "2026-10-22", windowEnd: "2026-10-29", source: "youtube-analytics-v2", collectedAt: "2026-10-29T12:00:00Z" },
  ],
};

/** Every source answered, nothing recorded yet. */
export const EMPTY: MemoryData = { users: { total: 0, rows: [] }, subscriptions: [], requests: [], costs: [], paidOps: [], capacity: [], finalCut: [], ytChannels: [], ytLinks: [], ytRows: [] };

/** Core tables exist; 0023–0028 not applied (PI, Final Cut and YouTube tables missing). */
export const MIGRATIONS_MISSING: MemoryData = { ...EMPTY, users: { total: 3, rows: [] }, requests: RICH.requests, costs: RICH.costs, unavailable: ["paidOps", "capacity", "finalCutDecisions", "youtubeChannels", "youtubeLinks", "youtubeRows"] };

/** Providers partly unknown, YouTube configured but not connected, failed job present. */
export const PARTIAL: MemoryData = { ...RICH, requests: [...RICH.requests!, { id: "r5", userId: "b", mode: "visual", status: "failed", createdAt: "2026-10-30T07:00:00Z", renderAttempts: 3, renderStartedAt: null, longFormStage: null }], ytChannels: [], ytLinks: [], ytRows: [], capacity: [RICH.capacity![1], { provider: "runway", unit: "usd", available: 1, reserved: 5, pending: 0, status: "RED", reliability: "provider_api", renewalDate: null, checkedAt: "2026-10-30T10:00:00Z" }] };

/** Database unreachable. */
export const SERVICE_DOWN: MemoryData = { unavailable: ["users", "subscriptions", "requests", "costs", "paidOps", "capacity", "finalCutDecisions", "youtubeChannels", "youtubeLinks", "youtubeRows"] };
