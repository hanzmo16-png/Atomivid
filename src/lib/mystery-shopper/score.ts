/**
 * Calificación 0–100. Un dato que no se midió queda en null, no en cero.
 * Un bloqueo crítico se devuelve aparte y no se esconde dentro del promedio.
 */
import type { Journey, ModuleScore, ProductId, ScreenObservation } from "./types";

export const WEIGHTS = { ease: 0.3, functionality: 0.25, quality: 0.2, costTransparency: 0.15, mobile: 0.1 } as const;

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function weighted(parts: Pick<ModuleScore, "ease" | "functionality" | "quality" | "costTransparency" | "mobile">): number | null {
  const entries = Object.entries(WEIGHTS) as [keyof typeof WEIGHTS, number][];
  if (entries.some(([k]) => parts[k] === null)) return null;
  const sum = entries.reduce((acc, [k, w]) => acc + (parts[k] as number) * w, 0);
  return Math.round(sum * 10) / 10;
}

function screensOf(journey: Journey, product: ProductId): ScreenObservation[] {
  return journey.screens.filter((s) => s.product === product);
}

export function scoreProduct(journey: Journey, product: ProductId, runProduct: ProductId): ModuleScore {
  const screens = screensOf(journey, product);
  const empty: ModuleScore = { product, ease: null, functionality: null, quality: null, costTransparency: null, mobile: null, weighted: null, criticalBlock: null };
  if (journey.scope === "no-observado" || screens.length === 0) {
    const reason = journey.errors[0] ?? "Sin recorrido visible de este producto.";
    return { ...empty, criticalBlock: journey.scope === "no-observado" ? reason : null };
  }

  const busiest = screens.reduce((a, s) => (s.clicks > a.clicks ? s : a), screens[0]);
  const jargon = screens.reduce((a, s) => a + s.technicalTerms.length, 0);
  const ease = clamp(100 - Math.max(0, busiest.clicks - 12) * 4 - Math.max(0, busiest.fields - 8) * 3 - Math.max(0, busiest.decisions - 6) * 3 - jargon * 5);

  const steps = product === runProduct ? journey.steps.filter((s) => s.status !== "skipped") : [];
  const obs = journey.products.find((p) => p.product === product);
  const functionality = steps.length
    ? clamp((steps.filter((s) => s.status === "ok").length / steps.length) * 100)
    : obs?.completedFreeFlow === true ? 100 : obs?.completedFreeFlow === false ? 35 : null;

  let quality: number | null = null;
  const fileProduct = product === "audio-podcast" || product === "video-podcast" || product === "reels" || product === "long-form";
  const media = journey.mediaByProduct[product] ?? (product === runProduct ? journey.media : null);
  if (fileProduct && media) {
    quality = media.technicalVerdict === "PASS" ? 100 : media.technicalVerdict === "PASS_WITH_WARNINGS" ? 70 : media.technicalVerdict === "FAIL" ? 20 : null;
  } else if (!fileProduct && screens.some((s) => /vista previa/i.test(s.visibleText))) {
    quality = 100;
  }

  const costScreens = screens.filter((s) => s.costVisible !== null);
  const costTransparency = costScreens.length === 0 ? null : clamp(costScreens.every((s) => s.costVisible && s.costLabel) ? 100 : 25);

  const mobileScreens = screens.filter((s) => s.mobileUsable !== null);
  const mobile = mobileScreens.length === 0 ? null : clamp(mobileScreens.every((s) => s.mobileUsable) ? 100 : 30);

  const download = screens.some((s) => s.couldDownload === false);
  const save = screens.some((s) => s.couldSave === false);
  const generate = screens.some((s) => s.couldGenerate === false);
  const critical = [generate ? "No se puede generar desde lo que el cliente ve." : null, save ? "No se puede guardar el proyecto." : null, download ? "No se puede descargar el archivo." : null].filter(Boolean).join(" ");

  const parts = { ease, functionality, quality, costTransparency, mobile };
  return { product, ...parts, weighted: weighted(parts), criticalBlock: critical || null };
}

export function scoreJourney(journey: Journey, runProduct: ProductId): ModuleScore[] {
  const products = [...new Set(journey.products.map((p) => p.product))];
  return products.map((p) => scoreProduct(journey, p, runProduct));
}
