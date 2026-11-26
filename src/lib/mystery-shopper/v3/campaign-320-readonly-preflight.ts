/**
 * Issue #320 — inspección autenticada y NO MUTANTE de las dos superficies que
 * todavía no tienen runner real. Este preflight no completa formularios, no
 * crea proyectos y no pulsa controles de generación: únicamente demuestra que
 * la cuenta QA puede llegar a la interfaz correcta antes de habilitar gasto.
 */

// Playwright es una dependencia del ejecutor, no de la aplicación.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = any;

export type Campaign320Surface = "reels" | "video-podcast";

export type ReadonlyObservation = {
  surface: Campaign320Surface;
  requestedPath: string;
  finalPath: string;
  httpStatus: number | null;
  loginRedirect: boolean;
  notFound: boolean;
  requiredVisible: Record<string, boolean>;
  enabledPaidControl: boolean;
  generationBlocked?: boolean;
};

export type ReadonlyVerdict = {
  state: "PASS" | "BLOCKED" | "FAIL";
  reasons: string[];
};

export const CAMPAIGN_320_READONLY_ROUTES: Record<Campaign320Surface, string> = {
  reels: "/dashboard/new?formato=reel",
  "video-podcast": "/dashboard/podcast",
};

export function evaluateReadonlyObservation(o: ReadonlyObservation): ReadonlyVerdict {
  const reasons: string[] = [];
  if (o.generationBlocked) reasons.push("La generación audiovisual está desactivada y pendiente de autorización.");
  if (o.loginRedirect) reasons.push("La sesión QA no está autenticada.");
  if (o.notFound || o.httpStatus === 404) reasons.push("La cuenta QA no tiene acceso a la superficie.");
  if (o.httpStatus !== null && o.httpStatus >= 500) reasons.push(`La superficie respondió HTTP ${o.httpStatus}.`);
  for (const [name, visible] of Object.entries(o.requiredVisible)) {
    if (!visible) reasons.push(`No se encontró el control requerido: ${name}.`);
  }
  if (o.enabledPaidControl) reasons.push("Hay un control de gasto habilitado durante el preflight no mutante.");

  if (o.generationBlocked || o.loginRedirect || o.notFound || o.httpStatus === 404) return { state: "BLOCKED", reasons };
  return { state: reasons.length ? "FAIL" : "PASS", reasons };
}

async function visible(locator: { isVisible: (options?: unknown) => Promise<boolean> }): Promise<boolean> {
  return locator.isVisible({ timeout: 3_000 }).catch(() => false);
}

/**
 * Navega y observa. La ausencia deliberada de click/fill/check/selectOption es
 * parte del contrato: puede ejecutarse contra producción sin crear datos.
 */
export async function inspectCampaign320SurfaceReadOnly(
  page: Page,
  surface: Campaign320Surface,
): Promise<{ observation: ReadonlyObservation; verdict: ReadonlyVerdict }> {
  const requestedPath = CAMPAIGN_320_READONLY_ROUTES[surface];
  const response = await page.goto(requestedPath, { waitUntil: "domcontentloaded" });
  // Hydrated client controls can arrive after DOMContentLoaded. Never treat
  // an immediate isVisible() snapshot as proof that a control is missing.
  await page.locator(surface === "reels" ? '[role="radiogroup"][aria-label="Guion"]' : '[data-testid="podcast-wizard"][data-hydrated="1"]').waitFor({ state: "attached", timeout: 15_000 }).catch(() => {});
  const url = new URL(page.url());
  const body = page.locator("body");
  const bodyText = String(await body.innerText({ timeout: 5_000 }).catch(() => ""));
  const common = {
    surface,
    requestedPath,
    finalPath: `${url.pathname}${url.search}`,
    httpStatus: response?.status?.() ?? null,
    loginRedirect: url.pathname === "/login",
    notFound: /no encontramos esa página/i.test(bodyText),
  };

  const requiredVisible: Record<string, boolean> = surface === "reels"
    ? {
        "Generar nuevo video": await visible(page.getByRole("heading", { name: "Generar nuevo video" })),
        "Reel": await visible(page.getByRole("radiogroup", { name: "Guion", exact: true })),
        "Tema o instrucciones": await visible(page.getByLabel(/Tema o instrucciones|Título del video/).first()),
        "Duración deseada": await visible(page.getByRole("radiogroup", { name: "Duración deseada" })),
      }
    : {
        "Podcast Studio": await visible(page.getByTestId("podcast-wizard")),
        "Asistente hidratado": await page.getByTestId("podcast-wizard").getAttribute("data-hydrated").then((v: string | null) => v === "1").catch(() => false),
        "Narración con imágenes": await visible(page.getByTestId("modalidad-visual")),
        "Presentador con avatar": await visible(page.getByTestId("modalidad-avatar")),
        "Conversación con avatares": await visible(page.getByTestId("modalidad-dialogo")),
        "Pasos": await visible(page.getByRole("list", { name: "Pasos" })),
      };

  const paid = page.getByRole("button", { name: /Generar episodio|Generar video final|Generar MP4/i });
  const paidCount = await paid.count().catch(() => 0);
  let enabledPaidControl = false;
  for (let i = 0; i < paidCount; i += 1) {
    const item = paid.nth(i);
    if (await visible(item) && await item.isEnabled().catch(() => false)) enabledPaidControl = true;
  }

  const observation: ReadonlyObservation = { ...common, requiredVisible, enabledPaidControl, generationBlocked: surface === "video-podcast" && /Disponible cuando se active el estudio|generación está desactivada|modo se activa cuando el propietario autorice/i.test(bodyText) };
  return { observation, verdict: evaluateReadonlyObservation(observation) };
}
