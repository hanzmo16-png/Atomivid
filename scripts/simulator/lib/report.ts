import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

export type Status = "PASS" | "FAIL" | "NOT_VERIFIED";

export type Check = { name: string; ok: boolean; detail?: unknown };

export type ScenarioResult = {
  id: string;
  mode: "reel" | "youtube" | "avatar" | "voice" | "billing";
  title: string;
  status: Status;
  reason: string;
  checks: Check[];
  steps: { at: string; step: string }[];
  elapsedMs: number;
  actual_provider_spend_usd: 0;
  billable_requests: Record<string, number>;
  artifacts: MediaEvidence[];
  data: Record<string, unknown>;
};

export type MediaEvidence = {
  path: string;
  sha256: string;
  bytes: number;
  ffprobe: { durationSeconds: number; video?: { codec: string; width: number; height: number; fps: string }; audio?: { codec: string; sampleRate: string; channels: number }[]; streams: number };
};

export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function probe(file: string): MediaEvidence {
  const raw = execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]).toString();
  fs.writeFileSync(`${file}.ffprobe.json`, raw);
  const j = JSON.parse(raw) as { streams: Record<string, string | number>[]; format: { duration: string } };
  const v = j.streams.find((s) => s.codec_type === "video");
  return {
    path: file,
    sha256: sha256File(file),
    bytes: fs.statSync(file).size,
    ffprobe: {
      durationSeconds: Number(j.format.duration),
      video: v ? { codec: String(v.codec_name), width: Number(v.width), height: Number(v.height), fps: String(v.r_frame_rate) } : undefined,
      audio: j.streams.filter((s) => s.codec_type === "audio").map((a) => ({ codec: String(a.codec_name), sampleRate: String(a.sample_rate), channels: Number(a.channels) })),
      streams: j.streams.length,
    },
  };
}

/** Decodifica el archivo completo; lanza si hay un error de flujo. */
export function decodeFully(file: string) {
  execFileSync("ffmpeg", ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"], { timeout: 600_000 });
}

export class Scenario {
  private started = Date.now();
  readonly checks: Check[] = [];
  readonly steps: { at: string; step: string }[] = [];
  readonly artifacts: MediaEvidence[] = [];
  data: Record<string, unknown> = {};
  notVerified: string | null = null;
  constructor(readonly id: string, readonly mode: ScenarioResult["mode"], readonly title: string) {}
  step(s: string) { this.steps.push({ at: `${((Date.now() - this.started) / 1000).toFixed(2)}s`, step: s }); }
  check(name: string, ok: boolean, detail?: unknown) { this.checks.push({ name, ok, detail }); return ok; }
  finish(billable: Record<string, number>, error?: unknown): ScenarioResult {
    if (error) this.checks.push({ name: "sin excepción inesperada", ok: false, detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
    const failed = this.checks.filter((c) => !c.ok);
    const status: Status = failed.length > 0 ? "FAIL" : this.notVerified ? "NOT_VERIFIED" : this.checks.length === 0 ? "NOT_VERIFIED" : "PASS";
    const reason = failed.length > 0 ? `Falló: ${failed.map((c) => c.name).join("; ")}` : this.notVerified ?? (this.checks.length ? `${this.checks.length} asserts OK` : "sin asserts");
    return { id: this.id, mode: this.mode, title: this.title, status, reason, checks: this.checks, steps: this.steps, elapsedMs: Date.now() - this.started, actual_provider_spend_usd: 0, billable_requests: billable, artifacts: this.artifacts, data: this.data };
  }
}
