/**
 * Mystery Shopper AI 1.0 — tipos del módulo.
 * El cliente misterioso observa la interfaz visible. Nada de aquí llama a un proveedor.
 */

export const MODULE_VERSION = "mystery-shopper-1.0";

export const PRODUCTS = [
  "audio-podcast",
  "video-podcast",
  "reels",
  "long-form",
  "youtube",
  "library",
  "command-center",
  "account-nav",
] as const;
export type ProductId = (typeof PRODUCTS)[number];

export const PRODUCT_LABEL: Record<ProductId, string> = {
  "audio-podcast": "Audio Podcast Studio",
  "video-podcast": "Video Podcast Studio",
  reels: "Reels Studio",
  "long-form": "Long Form Studio",
  youtube: "YouTube Studio",
  library: "Biblioteca",
  "command-center": "Command Center",
  "account-nav": "Cuenta y navegación",
};

/** Cinco estados pedidos. NO_VERIFICADO existe para no inventar un estado cuando el cliente no pudo abrir el producto. */
export const AVAILABILITY = [
  "DISPONIBLE_Y_FUNCIONAL",
  "CON_LIMITACIONES",
  "INTERFAZ_SIN_FUNCIONALIDAD_COMPLETA",
  "BLOQUEADO",
  "NO_DISPONIBLE",
  "NO_VERIFICADO",
] as const;
export type Availability = (typeof AVAILABILITY)[number];

export const PROFILES = ["principiante", "creador", "profesional", "impaciente"] as const;
export type ProfileId = (typeof PROFILES)[number];

export const PROFILE_LABEL: Record<ProfileId, string> = {
  principiante: "A Principiante",
  creador: "B Creador de contenido",
  profesional: "C Profesional exigente",
  impaciente: "D Impaciente en celular",
};

export const RUN_STATUSES = ["NO_INICIADA", "EN_PROCESO", "BLOQUEADA", "TERMINADA", "ERROR"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export type Severity = "P0" | "P1" | "P2" | "P3";
export type Complexity = "baja" | "media" | "alta";

export const FLOW_STEPS = [
  "Acceder al entorno",
  "Iniciar sesión",
  "Entrar desde el menú y encontrar el producto",
  "Crear un proyecto desde cero",
  "Escribir las instrucciones",
  "Elegir la configuración",
  "Validar el presupuesto",
  "Generar",
  "Observar el progreso",
  "Esperar a que termine o falle",
  "Inspeccionar el resultado",
  "Reproducirlo",
  "Descargarlo",
  "Verificar su integridad",
  "Guardar y recuperar el proyecto",
  "Evaluar la experiencia",
] as const;
export type FlowStepName = (typeof FLOW_STEPS)[number];

export type StepStatus = "ok" | "failed" | "skipped" | "blocked";

export type StepResult = {
  step: number;
  name: FlowStepName;
  status: StepStatus;
  screen: string;
  /** Texto visible para el cliente, recortado. Nunca selectores internos. */
  visibleText: string;
  detail: string;
  clicks: number;
  fields: number;
  decisions: number;
};

export type Finding = {
  id: string;
  product: ProductId;
  screen: string;
  problem: string;
  profile: ProfileId;
  evidence: string;
  severity: Severity;
  proposal: string;
  benefit: string;
  complexity: Complexity;
  state: "abierto" | "bloqueado";
  fact: string;
  interpretation: string;
  recommendation: string;
};

export type ModuleScore = {
  product: ProductId;
  /** null = no hubo recorrido que medir. No se disfraza de cero. */
  ease: number | null;
  functionality: number | null;
  quality: number | null;
  costTransparency: number | null;
  mobile: number | null;
  weighted: number | null;
  /** Bloqueo crítico aparte del promedio: no se puede generar, guardar o descargar. */
  criticalBlock: string | null;
};

export type MediaKind = "audio" | "video" | "unknown";

export type MediaReport = {
  path: string;
  labeledFixture: boolean;
  exists: boolean;
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  aspect: string | null;
  fps: number | null;
  audioTracks: number;
  silenceRanges: [number, number][];
  blackRanges: [number, number][];
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
  decodeErrors: string[];
  frameSample: { extracted: boolean; bytes: number; reason: string | null };
  /** La sincronización labial solo se aprueba con un método medible. */
  lipSync: { approved: false; method: null; reason: string };
  technicalVerdict: "PASS" | "PASS_WITH_WARNINGS" | "FAIL" | "NO_MEDIDO";
  technicalNotes: string[];
  subjective: "no evaluado";
};

export type ProductObservation = {
  product: ProductId;
  seenInMenu: boolean | null;
  opened: boolean | null;
  menuLabel: string | null;
  limitations: string[];
  blockedReason: string | null;
  completedFreeFlow: boolean | null;
};

export type ScreenObservation = {
  screen: string;
  product: ProductId;
  profile: ProfileId;
  visibleText: string;
  clicks: number;
  fields: number;
  decisions: number;
  costVisible: boolean | null;
  costLabel: string | null;
  technicalTerms: string[];
  progressVisible: boolean | null;
  couldGenerate: boolean | null;
  couldSave: boolean | null;
  couldDownload: boolean | null;
  couldPlay: boolean | null;
  doubleClickSafe: boolean | null;
  mobileUsable: boolean | null;
  fixtureBadge: boolean;
  errorVisible: string | null;
  publishControl: "ausente" | "deshabilitado" | "habilitado" | null;
  scheduleControl: "ausente" | "deshabilitado" | "habilitado" | null;
};

export type JourneyScope = "fixture-harness" | "atomivid-live" | "no-observado";

export type Journey = {
  scope: JourneyScope;
  missionId: string;
  sha: string;
  environment: string;
  baseUrl: string;
  steps: StepResult[];
  screens: ScreenObservation[];
  products: ProductObservation[];
  media: MediaReport | null;
  mediaByProduct: Partial<Record<ProductId, MediaReport>>;
  spendUsd: number;
  evidence: { label: string; note: string }[];
  errors: string[];
  liveProbe: { url: string; reached: boolean; detail: string } | null;
};

export type Mission = {
  id: string;
  product: ProductId;
  title: string;
  instructions: string;
  expected: string;
  /** YouTube: publicar y programar están prohibidos. */
  publishForbidden: boolean;
};

export type RunMode = "fixture" | "real";

export type RunReport = {
  version: typeof MODULE_VERSION;
  id: string;
  idempotencyKey: string;
  mode: RunMode;
  fixtureLabeled: boolean;
  status: RunStatus;
  stage: string;
  sha: string;
  environment: string;
  product: ProductId;
  profile: ProfileId;
  missionId: string;
  instructions: string;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  spendUsd: number;
  maxBudgetUsd: number;
  steps: StepResult[];
  findings: Finding[];
  scores: ModuleScore[];
  classifications: { product: ProductId; availability: Availability; evidence: string }[];
  media: MediaReport | null;
  errors: string[];
  recommendations: string[];
  evidence: { label: string; note: string }[];
  scope: JourneyScope;
  realMode: { executed: false; code: string; reason: string };
  /** Lo que se vio en ATOMIVID real, si se abrió. No se mezcla con el arnés fixture. */
  liveProbe: { url: string; reached: boolean; detail: string } | null;
};
