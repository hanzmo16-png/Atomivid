/**
 * Per-sequence editorial report of a plan (correction 2). Counts only what the plan and the inventory say: it
 * reports repetition, shot types, proposed vs available movement and pending decisions. It does not judge
 * visual quality, and movement "available" means declared in the inventory, not verified on real files.
 */
import type { DirectorInput, DirectorPlan } from "./contract";

const count = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ({ ...m, [x]: (m[x] ?? 0) + 1 }), {});

export function editorialReport(plan: DirectorPlan, input: DirectorInput) {
  const sequences = input.segments.map(seg => {
    const shots = plan.shots.filter(s => s.segmentId === seg.id);
    const free = shots.filter(s => s.asset.status !== "locked");
    // Conceptual repetition: same recipe or same visual theme within the two previous shots of the sequence.
    const repeats = free.flatMap((s, i) => free.slice(Math.max(0, i - 2), i)
      .filter(p => (p.recipeId && p.recipeId === s.recipeId) || p.visualTheme === s.visualTheme)
      .map(p => ({ shot: s.id, repeats: p.id, by: p.recipeId === s.recipeId ? `receta ${s.recipeId}` : "mismo tema visual", continuation: !!s.asset.continuation })));
    const realAvailable = input.inventory.filter(a => a.motion === "real" && a.kind !== "avatar" && a.tags.includes(`segment:${seg.id}`)).map(a => a.id);
    return {
      segmentId: seg.id, beat: seg.beat ?? null, shots: shots.length,
      shotTypes: count(free.map(s => s.shotType)),
      recipes: count(free.map(s => s.recipeId ?? "pendiente")),
      conceptualRepeats: repeats,
      movement: {
        proposed: count(free.map(s => s.movement.kind)),
        realMotionShots: free.filter(s => s.movement.realMotion).length,
        realMotionAvailableInInventory: realAvailable,
        note: "movimiento disponible = declarado en el inventario derivado del storyboard; no verificado sobre archivos reales",
      },
      policy: count(free.map(s => `${s.policy.class}${s.policy.unconfirmed ? " (no confirmado)" : ""}`)),
      decisions: count(free.map(s => s.decision.status)),
      reviewRequired: free.filter(s => s.policy.status === "review_required").map(s => s.id),
      pending: free.filter(s => s.decision.status === "pending").map(s => ({ shot: s.id, reason: s.decision.pendingReason ?? "" })),
      cutBoundaries: count(free.map(s => s.unit.boundary)),
    };
  });
  const all = plan.shots.filter(s => s.asset.status !== "locked");
  return {
    totals: {
      shots: all.length,
      decisions: count(all.map(s => s.decision.status)),
      policy: count(all.map(s => s.policy.class)),
      unconfirmedUnits: all.filter(s => s.policy.unconfirmed).length,
      reviewRequired: all.filter(s => s.policy.status === "review_required").length,
      neutralAtmosphere: all.filter(s => s.decision.neutral).length,
      conceptualRepeats: sequences.reduce((n, q) => n + q.conceptualRepeats.length, 0),
      movement: count(all.map(s => s.movement.kind)),
      realMotionShots: all.filter(s => s.movement.realMotion).length,
      cutBoundaries: count(all.map(s => s.unit.boundary)),
      timing: count(all.map(s => s.unit.timing)),
    },
    sequences,
    note: "conteos del plan; no miden calidad cinematográfica ni sustituyen la revisión humana",
  };
}
