/**
 * Evaluador de UX. Cada hallazgo sale de una señal observada.
 * Separa hecho, interpretación y recomendación. No rellena productos que nadie vio.
 */
import { classifyProduct } from "./classify";
import { scoreJourney } from "./score";
import { PRODUCTS, type Finding, type Journey, type ProductId, type RunReport, type ScreenObservation, type Severity } from "./types";

let seq = 0;
function id(product: ProductId, code: string): string {
  seq += 1;
  return `${product}-${code}-${seq}`;
}

function finding(partial: Omit<Finding, "id" | "state"> & { state?: Finding["state"] }): Finding {
  return { ...partial, id: id(partial.product, partial.severity), state: partial.state ?? "abierto" };
}

function fromScreen(s: ScreenObservation): Finding[] {
  const out: Finding[] = [];
  const base = { product: s.product, screen: s.screen, profile: s.profile, evidence: s.visibleText.slice(0, 400) };

  if (s.profile === "principiante" && s.technicalTerms.length > 0) {
    out.push(finding({
      ...base,
      problem: `Aparecen términos técnicos (${s.technicalTerms.join(", ")}) en una pantalla que el principiante tiene que usar para obtener el video.`,
      severity: "P2",
      proposal: "Sustituir cada término por lo que la persona obtiene, y dejar el detalle técnico en un texto secundario.",
      benefit: "El principiante puede terminar sin saber qué es un códec o un contenedor.",
      complexity: "baja",
      fact: `En «${s.screen}» el texto visible incluye: ${s.technicalTerms.join(", ")}.`,
      interpretation: "Quien solo quiere poner un tema y obtener un video puede frenarse en esa pantalla.",
      recommendation: "Reescribir esas etiquetas en lenguaje de resultado.",
    }));
  }
  if (s.clicks > 12) {
    out.push(finding({
      ...base,
      profile: s.profile,
      problem: `El recorrido sumó ${s.clicks} clics en esta pantalla.`,
      severity: "P2",
      proposal: "Juntar las decisiones obligatorias en un solo paso y dejar el resto como opciones avanzadas.",
      benefit: "Menos abandonos, sobre todo en el celular.",
      complexity: "media",
      fact: `Se contaron ${s.clicks} clics, ${s.fields} campos y ${s.decisions} decisiones en «${s.screen}».`,
      interpretation: "La fricción crece cuando cada dato pide un clic más.",
      recommendation: "Medir de nuevo el mismo recorrido después de reducir los clics obligatorios.",
    }));
  }
  if (s.costVisible === false) {
    out.push(finding({
      ...base,
      profile: "profesional",
      problem: "Antes de seguir, el cliente no ve cuánto cuesta esta acción.",
      severity: "P1",
      proposal: "Mostrar el máximo en USD, o «USD 0.00» si no hay cobro, en la misma pantalla del botón.",
      benefit: "Se puede decidir sin miedo a un cargo sorpresa.",
      complexity: "baja",
      fact: `En «${s.screen}» no hay un monto visible. Texto: ${s.visibleText.slice(0, 180)}`,
      interpretation: "Sin un monto, la confianza en el costo no se puede comprobar.",
      recommendation: "Poner el tope al lado de la acción principal.",
    }));
  }
  if (s.progressVisible === false) {
    out.push(finding({
      ...base,
      profile: "impaciente",
      problem: "No hay un indicador de que la acción sigue en curso.",
      severity: "P1",
      proposal: "Mostrar la etapa actual y desactivar el botón mientras tanto.",
      benefit: "Quien pulsa varias veces sabe si debe esperar o salir.",
      complexity: "baja",
      fact: `En «${s.screen}» no se vio un indicador de progreso.`,
      interpretation: "En el celular, la ausencia de señal se lee como fallo y lleva a abandonar o a pulsar de nuevo.",
      recommendation: "Añadir la etapa y el tiempo en esa pantalla.",
    }));
  }
  if (s.doubleClickSafe === false) {
    out.push(finding({
      ...base,
      profile: "impaciente",
      problem: "Un segundo pulso puede repetir la acción.",
      severity: "P1",
      proposal: "Ignorar el segundo pulso de la misma acción y conservar un solo id de ejecución.",
      benefit: "Se evita un proyecto duplicado o un segundo cobro.",
      complexity: "media",
      fact: `En «${s.screen}» el control sigue aceptando otro pulso.`,
      interpretation: "El perfil impaciente pulsa otra vez cuando no ve respuesta.",
      recommendation: "Desactivar el control hasta que la primera acción responda.",
    }));
  }
  if (s.mobileUsable === false) {
    out.push(finding({
      ...base,
      profile: "impaciente",
      problem: "En el ancho del celular hay contenido cortado o controles que no se pueden pulsar.",
      severity: "P1",
      proposal: "Apilar el contenido en una columna y mantener los botones a 44 px.",
      benefit: "El recorrido se puede terminar con una mano.",
      complexity: "media",
      fact: `En «${s.screen}» el recorrido móvil marcó la pantalla como no usable.`,
      interpretation: "Quien cambia de pantalla en el teléfono abandona si el control queda fuera.",
      recommendation: "Revisar esta pantalla a 390 px y a 412 px.",
    }));
  }
  if (s.publishControl === "habilitado" || s.scheduleControl === "habilitado") {
    out.push(finding({
      ...base,
      profile: "profesional",
      problem: "Publicar o programar está disponible durante una evaluación que lo prohíbe.",
      severity: "P0",
      proposal: "Quitar o desactivar publicar y programar en esta evaluación.",
      benefit: "Un recorrido de prueba no puede publicar un video.",
      complexity: "baja",
      state: "bloqueado",
      fact: `En «${s.screen}» publicar=${s.publishControl ?? "ausente"}, programar=${s.scheduleControl ?? "ausente"}. No se pulsó ninguno.`,
      interpretation: "Un control habilitado es una vía de publicación aunque esta pasada no lo haya usado.",
      recommendation: "Dejar ambos controles deshabilitados y decir por qué.",
    }));
  }
  if (s.couldDownload === false || s.couldSave === false || s.couldGenerate === false) {
    const what = [s.couldGenerate === false ? "generar" : null, s.couldSave === false ? "guardar" : null, s.couldDownload === false ? "descargar" : null].filter(Boolean).join(", ");
    out.push(finding({
      ...base,
      profile: "creador",
      problem: `El cliente no puede ${what}.`,
      severity: "P0",
      proposal: "Completar esa acción en la misma pantalla, con un archivo recuperable.",
      benefit: "El creador puede llevarse el resultado.",
      complexity: "alta",
      state: "bloqueado",
      fact: `En «${s.screen}»: generar=${String(s.couldGenerate)}, guardar=${String(s.couldSave)}, descargar=${String(s.couldDownload)}.`,
      interpretation: "Sin esa acción el encargo no se cierra.",
      recommendation: "Tratarlo como bloqueo crítico, fuera del promedio.",
    }));
  }
  if (s.errorVisible) {
    out.push(finding({
      ...base,
      problem: "La pantalla muestra un error al cliente.",
      severity: "P1" as Severity,
      proposal: "Explicar qué pasó y cuál es el siguiente paso, sin códigos internos.",
      benefit: "La persona sabe si reintentar o parar.",
      complexity: "baja",
      fact: `Texto de error visible: ${s.errorVisible.slice(0, 300)}`,
      interpretation: "Un error sin salida empuja a abandonar.",
      recommendation: "Reescribir el mensaje con la causa que el cliente puede entender y una sola acción.",
    }));
  }
  return out;
}

export function evaluateJourney(journey: Journey, product: ProductId): { findings: Finding[]; recommendations: string[] } {
  seq = 0;
  const findings: Finding[] = [];
  if (journey.scope === "fixture-harness") {
    for (const s of journey.screens) {
      if (!s.fixtureBadge) {
        findings.push(finding({
          product: s.product,
          screen: s.screen,
          profile: "profesional",
          problem: "Esta pantalla de prueba no dice que es un fixture.",
          severity: "P1",
          proposal: "Marcar FIXTURE en cada pantalla y en cada archivo.",
          benefit: "Nadie confunde la prueba con un resultado real ni con un cobro.",
          complexity: "baja",
          evidence: s.visibleText.slice(0, 300),
          fact: `En «${s.screen}» no está la marca FIXTURE.`,
          interpretation: "Sin la marca, el archivo de prueba puede tomarse por una entrega real.",
          recommendation: "Mostrar FIXTURE en el encabezado y en el nombre del archivo.",
        }));
      }
    }
  }
  if (journey.scope === "no-observado") {
    findings.push(finding({
      product,
      screen: "Entorno",
      profile: "principiante",
      problem: "No se pudo recorrer el producto con una cuenta de prueba.",
      severity: "P0",
      proposal: "Configurar el secreto de la cuenta de prueba autorizada y repetir el recorrido.",
      benefit: "La evaluación pasa a basarse en lo que el cliente ve dentro de ATOMIVID.",
      complexity: "baja",
      state: "bloqueado",
      evidence: journey.errors.join(" ").slice(0, 400) || "Sin observación.",
      fact: journey.errors[0] ?? "No hubo sesión de cliente.",
      interpretation: "Sin esa sesión no hay calificación real del producto.",
      recommendation: "No asignar una nota de funcionamiento hasta repetir el recorrido con la cuenta.",
    }));
  }
  for (const s of journey.screens.filter((s) => s.product === product || journey.scope === "fixture-harness")) {
    if (journey.scope === "fixture-harness" && s.product !== product && s.product !== "account-nav" && s.product !== "library") continue;
    findings.push(...fromScreen(s));
  }
  for (const step of journey.steps.filter((s) => s.status === "failed")) {
    findings.push(finding({
      product,
      screen: step.screen,
      profile: "principiante",
      problem: `El paso «${step.name}» no se completó.`,
      severity: "P0",
      proposal: "Corregir ese paso en la interfaz y repetir solo esa parte del recorrido.",
      benefit: "El cliente puede seguir sin quedarse a medias.",
      complexity: "media",
      state: "bloqueado",
      evidence: step.visibleText.slice(0, 300),
      fact: `Paso ${step.step} «${step.name}» falló. ${step.detail}`,
      interpretation: "El fallo corta el encargo en ese punto.",
      recommendation: step.detail || "Registrar la pantalla y el texto visible de ese fallo.",
    }));
  }
  const videoMedia = journey.mediaByProduct[product] ?? journey.media;
  if (videoMedia && videoMedia.lipSync.approved === false && (product === "video-podcast" || product === "reels" || product === "long-form")) {
    findings.push(finding({
      product,
      screen: "Archivo",
      profile: "profesional",
      problem: "La sincronización labial no se aprueba.",
      severity: "P2",
      proposal: "Añadir un método medible antes de dar por buena la sincronización.",
      benefit: "No se entrega un video como sincronizado sin evidencia.",
      complexity: "alta",
      evidence: videoMedia.lipSync.reason,
      fact: videoMedia.lipSync.reason,
      interpretation: "Decir que los labios coinciden, sin medición, sería una afirmación sin base.",
      recommendation: "Dejar la sincronización como no aprobada hasta tener esa medición.",
    }));
  }
  const recommendations = [...new Set(findings.map((f) => f.recommendation))];
  return { findings, recommendations };
}

export function classificationsOf(journey: Journey) {
  const byProduct = new Map(journey.products.map((p) => [p.product, p]));
  return PRODUCTS.map((product) => {
    const c = classifyProduct(byProduct.get(product) ?? null);
    return { product, ...c };
  });
}

export function reportFromJourney(partial: {
  id: string;
  idempotencyKey: string;
  mode: RunReport["mode"];
  product: ProductId;
  profile: RunReport["profile"];
  missionId: string;
  instructions: string;
  startedAt: string;
  finishedAt: string;
  maxBudgetUsd: number;
  realMode: RunReport["realMode"];
  journey: Journey;
}): RunReport {
  const { findings, recommendations } = evaluateJourney(partial.journey, partial.product);
  const scores = scoreJourney(partial.journey, partial.product);
  const failed = partial.journey.steps.some((s) => s.status === "failed");
  const blocked = partial.realMode.code !== "fixture" && partial.realMode.code !== "ok";
  const status: RunReport["status"] = partial.journey.scope === "no-observado" ? "BLOQUEADA" : failed ? "ERROR" : blocked && partial.mode === "real" ? "BLOQUEADA" : "TERMINADA";
  return {
    version: "mystery-shopper-1.0",
    id: partial.id,
    idempotencyKey: partial.idempotencyKey,
    mode: partial.mode,
    fixtureLabeled: partial.mode === "fixture",
    status,
    stage: status === "TERMINADA" ? "Informe listo" : status === "BLOQUEADA" ? "Bloqueada" : "Error",
    sha: partial.journey.sha,
    environment: partial.journey.environment,
    product: partial.product,
    profile: partial.profile,
    missionId: partial.missionId,
    instructions: partial.instructions,
    startedAt: partial.startedAt,
    finishedAt: partial.finishedAt,
    elapsedMs: Math.max(0, Date.parse(partial.finishedAt) - Date.parse(partial.startedAt)),
    spendUsd: partial.journey.spendUsd,
    maxBudgetUsd: partial.maxBudgetUsd,
    steps: partial.journey.steps,
    findings,
    scores,
    classifications: classificationsOf(partial.journey),
    media: partial.journey.media,
    errors: partial.journey.errors,
    recommendations,
    evidence: partial.journey.evidence,
    scope: partial.journey.scope,
    realMode: partial.realMode,
    liveProbe: partial.journey.liveProbe,
  };
}
