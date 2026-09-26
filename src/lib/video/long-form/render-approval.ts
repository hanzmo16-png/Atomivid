/**
 * Controles previos al render que dependen del CONTENIDO de las escenas
 * (calidad M2), complementarios al preflight estructural
 * (render-preflight.ts):
 *
 * - Tarjetas "large": deben caber con los tamaños mínimos legibles; nunca
 *   se encogen para que quepan.
 * - Render de APROBACIÓN: bloqueado mientras exista alguna escena marcada
 *   como pendiente (carencia o recurso sin revisión visual). Un render
 *   técnico puede mostrarlas, pero siempre con la marca visible.
 */
import type { LongFormShotScene } from "../../../../remotion/LongFormDoc";
import { fitLargeCard } from "../../../../remotion/long-form-card-fit";

export class RenderApprovalError extends Error {
  constructor(
    message: string,
    readonly issues: { sceneId: string; reason: string }[],
  ) {
    super(message);
    this.name = "RenderApprovalError";
  }
}

export function cardFitIssues(scenes: LongFormShotScene[]): { sceneId: string; reason: string }[] {
  const issues: { sceneId: string; reason: string }[] = [];
  for (const scene of scenes) {
    if (scene.asset.kind !== "graphic" || scene.asset.graphic.kind !== "text" || scene.asset.graphic.size !== "large") continue;
    const fit = fitLargeCard(scene.asset.graphic.title, scene.asset.graphic.body);
    if (!fit.fits) {
      issues.push({ sceneId: scene.id, reason: `tarjeta desborda (${fit.titleLines} líneas de título, ${fit.bodyLines} de cuerpo, ~${Math.round(fit.heightPx)} px)` });
    }
  }
  return issues;
}

export function assertCardsFit(scenes: LongFormShotScene[]): void {
  const issues = cardFitIssues(scenes);
  if (issues.length > 0) throw new RenderApprovalError(`Tarjetas ilegibles: ${issues.map((i) => `${i.sceneId}: ${i.reason}`).join("; ")}`, issues);
}

export function assertApprovalReady(scenes: LongFormShotScene[]): void {
  const issues = scenes.filter((s) => s.pending).map((s) => ({ sceneId: s.id, reason: s.pending as string }));
  if (issues.length > 0) {
    throw new RenderApprovalError(
      `Render de aprobación bloqueado: ${issues.length} escena(s) pendientes — ${issues.map((i) => `${i.sceneId}: ${i.reason}`).join("; ")}`,
      issues,
    );
  }
}
