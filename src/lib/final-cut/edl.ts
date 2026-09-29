/**
 * The inspected object: a master described as an Edit Decision List plus measured signals.
 * Two sources feed it: an edit timeline (storyboard / production records) and, when the
 * media file is available, local ffmpeg measurements (black, freeze, silence, loudness).
 * Fields that were not measured stay null: the inspectors then report "not assessable".
 */
import { z } from "zod";
import type { SlotKind, SlotMotion } from "../production-core/timeline-rules";

export const EDL_VERSION = "final-cut-edl/1";

export type EdlSlot = {
  slotId: string;
  shotId: string | null;
  startSec: number;
  durationSec: number;
  kind: SlotKind;
  motion: SlotMotion;
  /** Content identity for repetition (asset id / dedup key). */
  visualKey: string;
  beatId: string;
  /** Provider that produced the picture, when known. */
  sourceProvider?: string | null;
  /** QA evidence recorded during production (never guessed here). */
  qaFindings?: string[];
  /** Validated alternates already produced for this slot (usable by AUTO_FIX substitution). */
  validatedAlternates?: string[];
};

export type Interval = { startSec: number; endSec: number };
export type Caption = { id: string; text: string; startSec: number; endSec: number; /** fraction of frame height where the caption's bottom edge sits (0 top .. 1 bottom) */ bottomY?: number; leftX?: number; rightX?: number };

export type MasterEdl = {
  edlVersion: typeof EDL_VERSION;
  masterId: string;
  productionId: string;
  /** What the EDL was built from; the report carries it so nobody mistakes a plan for pixels. */
  source: { kind: "media" | "edit_timeline" | "media+edit_timeline"; ref: string };
  durationSec: number;
  width: number | null;
  height: number | null;
  fps: number | null;
  slots: EdlSlot[];
  speech: Interval[];
  captions: Caption[];
  measured: {
    blackIntervals: Interval[] | null;
    freezeIntervals: Interval[] | null;
    silenceIntervals: Interval[] | null;
    integratedLufs: number | null;
    truePeakDbtp: number | null;
    clippingSamples: number | null;
    /** Voice vs music level difference in dB (positive = voice louder), when a stem mix report exists. */
    voiceOverMusicDb: number | null;
    fadeInSec: number | null;
    fadeOutSec: number | null;
  };
};

const Interval = z.object({ startSec: z.number().nonnegative(), endSec: z.number().nonnegative() });
export const MasterEdlSchema = z.object({
  edlVersion: z.literal(EDL_VERSION),
  masterId: z.string().min(1),
  productionId: z.string().min(1),
  source: z.object({ kind: z.enum(["media", "edit_timeline", "media+edit_timeline"]), ref: z.string() }),
  durationSec: z.number().positive(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  fps: z.number().positive().nullable(),
  slots: z.array(z.object({ slotId: z.string(), shotId: z.string().nullable(), startSec: z.number().nonnegative(), durationSec: z.number().positive(), kind: z.enum(["generated_image", "animated_generated_image", "stock_video", "stock_image", "graphic", "text_card", "black", "existing_clip"]), motion: z.enum(["static", "camera", "live"]), visualKey: z.string(), beatId: z.string(), sourceProvider: z.string().nullable().optional(), qaFindings: z.array(z.string()).optional(), validatedAlternates: z.array(z.string()).optional() })),
  speech: z.array(Interval),
  captions: z.array(z.object({ id: z.string(), text: z.string(), startSec: z.number().nonnegative(), endSec: z.number().nonnegative(), bottomY: z.number().optional(), leftX: z.number().optional(), rightX: z.number().optional() })),
  measured: z.object({ blackIntervals: z.array(Interval).nullable(), freezeIntervals: z.array(Interval).nullable(), silenceIntervals: z.array(Interval).nullable(), integratedLufs: z.number().nullable(), truePeakDbtp: z.number().nullable(), clippingSamples: z.number().int().nonnegative().nullable(), voiceOverMusicDb: z.number().nullable(), fadeInSec: z.number().nullable(), fadeOutSec: z.number().nullable() }),
});

export function parseEdl(v: unknown): MasterEdl { return MasterEdlSchema.parse(v) as MasterEdl; }

export const emptyMeasured = (): MasterEdl["measured"] => ({ blackIntervals: null, freezeIntervals: null, silenceIntervals: null, integratedLufs: null, truePeakDbtp: null, clippingSamples: null, voiceOverMusicDb: null, fadeInSec: null, fadeOutSec: null });

export const r2 = (x: number) => Math.round(x * 100) / 100;
export const slotEnd = (s: EdlSlot) => r2(s.startSec + s.durationSec);
export const slotsSorted = (e: MasterEdl) => [...e.slots].sort((a, b) => a.startSec - b.startSec || a.slotId.localeCompare(b.slotId));
export const slotAt = (e: MasterEdl, t: number): EdlSlot | null => slotsSorted(e).find((s) => t >= s.startSec && t < slotEnd(s)) ?? null;
