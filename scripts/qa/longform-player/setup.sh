#!/usr/bin/env bash
# Creates the UNCOMMITTED local harness for the Long Form player QA: a dev-only page that simulates the
# owner check and re-signs links on every render, plus reproducible VP9/Opus MP4 fixtures (Playwright's
# Chromium has no H.264). Nothing here is committed: run teardown.sh before any commit.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
mkdir -p public/qa-media src/app/dev/player-qa
cat > src/app/dev/player-qa/page.tsx <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ResultView } from "@/components/video/ResultView";
import type { VideoRequestSummary } from "@/lib/video/request-view";

// UNCOMMITTED local QA harness. Simulates the real page's two server duties: the owner check
// (account → its own requests; anything else is notFound) and re-signing links on every render.
export const dynamic = "force-dynamic";
const OWNS: Record<string, string[]> = { u1: ["a"], u2: ["b"] };
export default async function Page({ searchParams }: { searchParams: Promise<{ v?: string; as?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { v = "a", as = "u1" } = await searchParams;
  if (!OWNS[as]?.includes(v)) notFound();
  const f = process.env.QA_STATE_FILE!;
  const st = JSON.parse(readFileSync(f, "utf8")) as { renders: number; fail?: boolean; failThumb?: boolean; delayMs?: number };
  st.renders += 1; writeFileSync(f, JSON.stringify(st));
  if (st.delayMs) await new Promise((r) => setTimeout(r, st.delayMs));
  const sign = (p: string) => `http://localhost:3141/qa-media/${p}?token=sig-${st.renders}`;
  const request = { id: `req-${v}`, mode: "long_form", topic: `QA documental ${v.toUpperCase()}`, style: "documentary", duration_seconds: 60,
    language: "es", status: "completed", video_path: `req-${v}/output/final.mp4`, error_message: null, script_json: null, progress_stage: null,
    render_attempts: 1, render_started_at: null, created_at: "2026-10-21T00:00:00Z", aspect_ratio: "16:9", long_form_stage: null,
    long_form_progress: null, long_form_confirmed_at: "2026-10-21T00:00:00Z" } as unknown as VideoRequestSummary;
  return (
    <main className="mx-auto max-w-md p-4">
      <ResultView request={request} videoUrl={st.fail ? null : sign(`${v}.mp4`)} thumbnailUrl={st.fail || st.failThumb ? null : sign(`${v}.jpg`)} thumbnailRequested nowMs={0} />
      <nav className="mt-4 flex gap-3 text-sm">
        <Link href="/dev/player-qa?v=a&as=u1" data-testid="go-a">Video A (u1)</Link>
        <Link href="/dev/player-qa?v=b&as=u2" data-testid="go-b">Video B (u2)</Link>
      </nav>
      <p data-testid="renders">{st.renders}</p>
    </main>
  );
}
EOF
cd public/qa-media
ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=640x360:rate=25 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 60 \
  -c:v libvpx-vp9 -b:v 600k -deadline realtime -cpu-used 8 -c:a libopus -movflags +faststart a.mp4
ffmpeg -loglevel error -y -f lavfi -i smptebars=size=640x360:rate=25 -f lavfi -i sine=frequency=660:sample_rate=48000 -t 45 \
  -c:v libvpx-vp9 -b:v 300k -deadline realtime -cpu-used 8 -c:a libopus -movflags +faststart b.mp4
ffmpeg -loglevel error -y -f lavfi -i testsrc2=size=1280x720 -frames:v 1 a.jpg
ffmpeg -loglevel error -y -f lavfi -i smptebars=size=1280x720 -frames:v 1 b.jpg
echo "harness ready: src/app/dev/player-qa + public/qa-media (do not commit)"
