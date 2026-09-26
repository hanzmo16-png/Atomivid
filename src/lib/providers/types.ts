/**
 * Interfaces comunes de proveedor. Cada etapa del pipeline (guion, voz,
 * footage, música) tiene una implementación "real" (llama a la API externa)
 * y una implementación "fixture" (determinística, sin red) que cumple la
 * misma interfaz — así el pipeline completo se puede probar sin claves.
 */
import type { ChargeOutcome } from "./charge-outcome";

export type SceneEnergy = "low" | "medium" | "high";

export type ScriptScene = {
  text: string;
  /** Concepto visual primario — 2-4 palabras en inglés, editable por el usuario en la revisión del guion. */
  visualQuery: string;
  /**
   * Interpretaciones visuales ALTERNATIVAS de la misma idea (no sinónimos
   * del mismo objeto/escena) — p. ej. para "ahí es donde la mayoría
   * abandona sus sueños": ["exhausted athlete stopping", "person quitting
   * workout", "runner falling behind"], no variaciones de "dreams".
   * Ausente en guiones antiguos o generados por el proveedor fixture — el
   * selector de footage cae a usar solo [visualQuery] cuando falta (ver
   * src/lib/video/footage-select.ts).
   */
  visualConcepts?: string[];
  /** Términos que NO deben aparecer en el material visual de esta escena. */
  excludedTerms?: string[];
  /** Señal de ritmo/energía para el montaje (corte más rápido en escenas "high"). */
  energy?: SceneEnergy;
  /** Palabras de esta escena que deben recibir énfasis visual en los subtítulos (ver caption-emphasis.ts). */
  emphasisWords?: string[];
  /**
   * «Animación IA»: la acción visible concreta de la escena (en inglés), que
   * el clip debe completar dentro de la duración visible del plano. Opcional
   * en el guion; obligatoria para animar (readiness.ts la exige).
   */
  visibleAction?: string;
  /** «Animación IA»: pose inicial ANTERIOR a la acción (primer fotograma; la acción aún no empezó). */
  actionStart?: string;
  /** «Animación IA»: estado final que se mantiene hasta el corte (destino de la acción; no se revierte). */
  actionEnd?: string;
};

export type GeneratedScript = {
  title: string;
  segments: ScriptScene[];
};

export type ScriptLanguage = "es" | "en";

/** Una llamada REAL al modelo de guion (cada corrección de longitud y cada reintento es otra). */
export type ScriptCallMeta = {
  operation: "script" | "scene";
  /** Número de llamada dentro de esta generación (1, 2, …), contando reintentos. */
  call: number;
  /** Intento de longitud (1 = primer borrador; 2-3 = correcciones). */
  lengthAttempt: number;
  model: string;
  maxTokens: number;
  /** Caracteres de system + mensaje enviados (para reservar antes de llamar). */
  promptChars: number;
};

/** Tokens medidos que devuelve el proveedor en la respuesta. */
export type ScriptCallUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

/**
 * Envoltorio opcional de CADA llamada real (p. ej. registro de gasto de las
 * muestras). Debe invocar `call` como máximo una vez y devolver su resultado.
 */
export type ScriptCallRunner = <T extends { usage?: ScriptCallUsage | null }>(meta: ScriptCallMeta, call: () => Promise<T>) => Promise<T>;

export interface ScriptProvider {
  readonly name: string;
  generateScript(input: {
    topic: string;
    style: string;
    durationSeconds: number;
    /** Idioma elegido por el usuario en /dashboard/new. Por defecto "es". */
    language?: ScriptLanguage;
    /** Guía de redacción de la dirección audiovisual (intención narrativa). Ausente = prompt anterior sin cambios. */
    guidance?: string;
    /** Envoltorio de cada llamada real (ver ScriptCallRunner). Ausente = llamada directa. */
    runCall?: ScriptCallRunner;
  }): Promise<GeneratedScript>;
  /** Reescribe una sola escena (revisión/edición desde la UI). */
  regenerateScene(input: {
    topic: string;
    style: string;
    script: GeneratedScript;
    sceneIndex: number;
    guidance?: string;
    runCall?: ScriptCallRunner;
  }): Promise<ScriptScene>;
}

export type WordTiming = {
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type VoiceResult = {
  audioBuffer: Buffer;
  durationSeconds: number;
  words: WordTiming[];
  mimeType: string;
  extension: string;
};

export interface VoiceProvider {
  readonly name: string;
  /**
   * `speed` (opcional, ~0.85-1.15): ajuste de ritmo de habla sin cambiar
   * el texto — usado por generate-video.ts para corregir una narración
   * real cuya duración medida cayó fuera de tolerancia, sin tener que
   * regenerar el guion ya aprobado por el usuario en la revisión. Omitido
   * = velocidad normal del proveedor.
   */
  synthesize(text: string, language?: ScriptLanguage, speed?: number): Promise<VoiceResult>;
}

export type FootageResult = {
  url: string;
  mediaType: "image" | "video";
  photographer?: string;
  mimeType: string;
  extension: string;
};

/**
 * Un resultado candidato (no elegido todavía) — a diferencia de
 * FootageResult, siempre trae un `sourceId` estable para poder
 * deduplicar entre escenas del mismo video, y metadata técnica opcional
 * para puntuar calidad (src/lib/video/footage-score.ts).
 */
export type FootageCandidate = FootageResult & {
  /** Identificador estable del candidato en el proveedor (p. ej. el id numérico de Pexels) — nunca la URL firmada, que puede cambiar. */
  sourceId: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  /** Texto descriptivo del proveedor (alt / slug de la página) — pertinencia por palabras clave, NO validación semántica. Aditivo, opcional. */
  description?: string;
  /** Página pública del recurso (procedencia/atribución). Aditivo, opcional. */
  pageUrl?: string;
};

export interface FootageProvider {
  readonly name: string;
  /** Busca preferentemente video (vertical por defecto; "landscape" para Long Form 16:9); el proveedor puede caer a imagen. */
  fetchFootage(query: string, minimumDurationSeconds?: number, orientation?: "portrait" | "landscape"): Promise<FootageResult>;
  downloadFootage(url: string): Promise<Buffer>;
  /**
   * Devuelve VARIOS candidatos de video para una consulta (no elige uno
   * solo) — necesario para poder puntuar, diversificar y evitar
   * duplicados entre escenas del mismo video. Opcional: un proveedor que
   * no lo implemente (p. ej. el fixture) hace que el selector caiga a
   * `fetchFootage` como candidato único, sin comparar alternativas.
   */
  searchVideoCandidates?(
    query: string,
    minimumDurationSeconds?: number,
    orientation?: "portrait" | "landscape",
  ): Promise<FootageCandidate[]>;
  /** Igual que `searchVideoCandidates` pero para fotos — último recurso cuando ningún concepto encuentra video. */
  searchImageCandidates?(query: string, orientation?: "portrait" | "landscape"): Promise<FootageCandidate[]>;
}

/** Categoría de tono musical normalizada — ver src/lib/providers/music/tone.ts. */
export type MusicTone =
  | "motivational"
  | "corporate"
  | "cinematic"
  | "inspirational"
  | "tension"
  | "reflective"
  | "energetic"
  | "minimal"
  | "technology"
  | "luxury";

/** Procedencia verificable de una pista — para poder justificar la licencia. */
export type MusicTrackMetadata = {
  /** Fuente real de la pista (p. ej. "pixabay", "mixkit"), no el mecanismo de selección. */
  provider: string;
  trackId: string;
  title: string;
  author: string;
  sourceUrl: string;
  license: string;
  tones: MusicTone[];
};

export type MusicResult = {
  audioBuffer: Buffer;
  durationSeconds: number;
  mimeType: string;
  extension: string;
  /** Ausente solo en el proveedor fixture o en el modo "lista plana de URLs" sin manifest. */
  track?: MusicTrackMetadata;
};

export type MusicSelectionContext = {
  durationSeconds: number;
  /** Mismo valor que el usuario eligió en /dashboard/new (p. ej. "Motivacional"). */
  style?: string;
  topic?: string;
  /** Texto completo narrado — se escanea por palabras clave para afinar el tono. */
  scriptText?: string;
  language?: ScriptLanguage;
  /**
   * Semilla para que la selección sea determinística y repetible (mismo
   * seed + mismo manifest ⇒ misma pista) — usa el requestId. Sin ella, la
   * elección entre pistas empatadas es aleatoria.
   */
  seed?: string;
  /**
   * Dirección musical aprobada (src/lib/video/audiovisual/). Presente =
   * modo dirigido: solo pistas compatibles, sin fallback a otra cualquiera
   * y sin inferir tono por palabras sueltas. Ausente = comportamiento
   * anterior (solicitudes sin dirección audiovisual).
   */
  direction?: import("@/lib/video/audiovisual/catalog").MusicDirectionId;
};

export interface MusicProvider {
  readonly name: string;
  getTrack(context: MusicSelectionContext): Promise<MusicResult>;
}

/**
 * Contratos compartidos por los proveedores GENERATIVOS nuevos (imagen,
 * video premium) — separados de los proveedores de stock de arriba porque
 * tienen un ciclo de vida distinto (piden, esperan, a veces pagan por
 * intento fallido) y necesitan más metadata para controlar costo y
 * observabilidad (ver Visual Director / feature-flags.ts).
 */

export type GenerativeCapabilities = {
  /** Identificador estable del proveedor (p. ej. "openai", "runway", "fixture"). */
  id: string;
  /** Modelos concretos que este proveedor puede usar (p. ej. ["gpt-image-2"]). */
  models: string[];
  /** Formatos de archivo que puede devolver. */
  formats: string[];
  /** Relaciones de aspecto soportadas nativamente (no todas garantizan 9:16 exacto). */
  aspectRatios: string[];
  /** Tiempo máximo de espera por intento, en milisegundos. */
  timeoutMs: number;
  /** Reintentos máximos ante error transitorio (no ante rechazo de moderación). */
  maxRetries: number;
};

/** Resultado normalizado de una generación de imagen o video — igual forma sin importar el proveedor. */
export type GenerativeAsset = {
  buffer: Buffer;
  mimeType: string;
  extension: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  /** Modelo exacto que produjo el resultado — para trazabilidad/costos. */
  model: string;
  /** Costo real si el proveedor lo expone, o la estimación calculada antes de pedir. */
  costUsd: number;
  /** De dónde sale `costUsd` (registro de gasto): usage medido del proveedor o estimación. Ausente = estimación. */
  costBasis?: "provider_usage" | "estimated";
  /** Identificador de la tarea/job en el proveedor, si aplica (generación asíncrona). */
  providerJobId?: string;
  /** Licencia o términos aplicables al resultado generado, cuando el proveedor los declara. */
  license?: string;
  /**
   * true si el buffer devuelto ya incluye una pista de audio generada por
   * el proveedor (p. ej. Veo, que siempre genera audio nativo, ver veo.ts)
   * — ausente/false para proveedores mudos (fixture, runway, imagen). El
   * renderer/pipeline de ATOMIVID usa su propia narración/música/ambience;
   * este campo solo avisa que el clip trae audio embebido que debe
   * ignorarse o descartarse al integrarlo, nunca lo elimina por sí mismo.
   */
  sourceHasGeneratedAudio?: boolean;
};

/** Error base para cualquier fallo de un proveedor generativo — siempre tipado, nunca un Error genérico. */
export class GenerativeProviderError extends Error {
  constructor(
    message: string,
    public readonly providerId: string,
    public readonly reason:
      | "not_configured"
      | "budget_exceeded"
      | "timeout"
      | "moderation_rejected"
      | "invalid_response"
      | "upstream_error"
      /**
       * El endpoint/payload/auth de este proveedor NO está verificado
       * contra documentación primaria en este entorno (ver kling.ts,
       * AI Video Pipeline P2A) — nunca se intenta una llamada HTTP real con
       * un contrato adivinado; generateVideo() lanza esto SIEMPRE, sin
       * importar si hay credenciales configuradas, hasta que un humano
       * confirme el contrato real contra la doc oficial.
       */
      | "contract_unverified"
      /** Credenciales presentes pero rechazadas por el proveedor (401/403 o equivalente) — distinto de "not_configured" (credenciales ausentes). */
      | "authentication_error"
      /** Cuota total agotada (plan/billing) — distinto de "rate_limited" (límite de velocidad temporal). */
      | "quota_exceeded"
      /** Límite de velocidad temporal (HTTP 429 u equivalente) — reintentar más tarde podría funcionar, a diferencia de "quota_exceeded". */
      | "rate_limited"
      /** El proveedor rechazó la solicitud por estar mal formada (HTTP 400 u equivalente) — distinto de "invalid_response" (la RESPUESTA del proveedor es la que está mal formada). */
      | "invalid_request"
      /** La generación se completó en el proveedor pero la descarga del archivo resultante falló (URL expirada, HTTP no-200, cuerpo vacío). */
      | "download_failed",
    public readonly cause?: unknown,
    /**
     * El identificador de operación/job del proveedor (p. ej. "operations/abc123"
     * de Veo), cuando el fallo ocurrió DESPUÉS de que el proveedor ya creó/aceptó
     * la solicitud (p. ej. un fallo transitorio al consultar el estado, o al
     * descargar el resultado ya generado) — permite que el llamador conserve el
     * identificador para diagnóstico/recuperación manual en vez de perderlo si el
     * error se propaga sin más contexto. Ausente cuando el fallo ocurrió ANTES de
     * que existiera ninguna operación (p. ej. la propia solicitud de creación fue
     * rechazada).
     */
    public readonly providerJobId?: string,
    /**
     * Si la llamada fallida pudo cobrarse (ver providers/charge-outcome.ts).
     * Ausente en proveedores que aún no lo declaran: el llamador debe
     * tratarlo como incierto salvo que `reason` pruebe que no se llamó.
     */
    public readonly chargeOutcome?: ChargeOutcome,
  ) {
    super(message);
    this.name = "GenerativeProviderError";
  }
}

export type ImageGenerationRequest = {
  prompt: string;
  negativePrompt?: string;
  /**
   * Relación de aspecto deseada — el proveedor puede devolver la más
   * cercana y dejar que se recorte después. "9:16" es el valor histórico
   * (Shorts/Avatar, todos los llamadores existentes). "16:9" se agregó
   * para Long Form (ver src/lib/video/long-form/) — un llamador que omite
   * "16:9" nunca lo recibe, así que este campo no cambia el comportamiento
   * de ningún proveedor existente para pedidos "9:16".
   */
  aspectRatio: "9:16" | "16:9";
  /** Presupuesto máximo para ESTE recurso — el proveedor debe rechazar (BUDGET_EXCEEDED) antes de pedir si lo excedería, no después. */
  maxCostUsd: number;
};

export interface ImageProvider {
  readonly name: string;
  readonly capabilities: GenerativeCapabilities;
  isAvailable(): boolean;
  generateImage(request: ImageGenerationRequest): Promise<GenerativeAsset>;
}

export type VideoGenerationRequest = {
  prompt: string;
  negativePrompt?: string;
  /**
   * "9:16" es el valor histórico (Shorts/Avatar, todos los llamadores
   * existentes). "16:9" se agregó para el AI Video Pipeline de Long Form
   * (ver src/lib/video/long-form/ai-video-*.ts) — mismo criterio aditivo
   * ya usado en ImageGenerationRequest.aspectRatio: un llamador que omite
   * "16:9" nunca lo recibe, así que esto no cambia el comportamiento de
   * ningún proveedor existente para pedidos "9:16".
   */
  aspectRatio: "9:16" | "16:9";
  durationSeconds: number;
  maxCostUsd: number;
  /**
   * Referencia opcional a una imagen ya generada/aprobada (p. ej. la URL o
   * buffer de un shot AI_RECREATION) para animación image-to-video —
   * ausente = generación text-to-video pura. Ningún proveedor existente
   * (fixture/runway) la usa todavía; queda reservada para no bloquear un
   * adaptador futuro que sí soporte image-to-video.
   */
  referenceImageUrl?: string;
  /** Semilla opcional para reproducibilidad, cuando el proveedor la soporte — ausente = no determinístico. */
  seed?: string;
  /** Metadata de trazabilidad libre (p. ej. shotId, videoId) — nunca interpretada por el proveedor, solo para observabilidad del llamador. */
  metadata?: Record<string, string>;
  /**
   * Llamado por el proveedor en cuanto la operación pagada fue ACEPTADA
   * (tiene id), antes de sondear — permite persistir el providerJobId para
   * que un crash durante el sondeo se reanude en vez de reenviar. Un fallo
   * de este callback nunca aborta una operación ya pagada.
   */
  onProviderJobAccepted?: (providerJobId: string) => Promise<void> | void;
};

export interface VideoProvider {
  readonly name: string;
  readonly capabilities: GenerativeCapabilities;
  isAvailable(): boolean;
  generateVideo(request: VideoGenerationRequest): Promise<GenerativeAsset>;
  /**
   * Reanuda el sondeo de una generación asíncrona YA enviada al proveedor
   * (identificada por `operationName`/`providerJobId`) sin volver a
   * enviar la solicitud original — RC mission Fase 5 ("providerJobId
   * recovery"): si un worker muere entre que el proveedor aceptó la
   * solicitud (ya facturable) y que el resultado se persistió, un retry
   * debe poder recuperar ESA misma operación en vez de crear una segunda.
   * Opcional: solo los proveedores con generación asíncrona de larga
   * duración y sondeo propio (Veo) lo implementan; ausente = ese proveedor
   * no admite reanudar (el llamador decide qué hacer, nunca reintenta a
   * ciegas en su lugar).
   */
  resumeGeneration?(operationName: string, request: VideoGenerationRequest): Promise<GenerativeAsset>;
}

// Alias por nombre de producto — el "PremiumVideoProvider" pedido en la
// especificación del modo Avatar es exactamente el VideoProvider (Runway)
// ya implementado arriba. Mismo tipo, dos nombres, cero duplicación.
export type PremiumVideoProvider = VideoProvider;
// Igual para ImageProvider/MusicProvider bajo los nombres pedidos.
export type ImageGenerationProvider = ImageProvider;
export type MusicGenerationProvider = MusicProvider;

/**
 * Contrato del proveedor de video con AVATAR (HeyGen es la primera
 * implementación, ver providers/avatar/heygen.ts) — separado de
 * ImageProvider/VideoProvider porque su ciclo de vida tiene DOS etapas
 * asíncronas independientes (crear/entrenar el avatar UNA vez, luego
 * generar N videos reutilizando ese mismo avatar), no una sola llamada.
 */
export type AvatarJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export class AvatarProviderError extends Error {
  constructor(
    message: string,
    public readonly providerId: string,
    public readonly reason:
      | "not_configured"
      | "consent_missing"
      | "budget_exceeded"
      | "timeout"
      | "moderation_rejected"
      | "invalid_response"
      | "upstream_error"
      | "circuit_open",
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AvatarProviderError";
  }
}

export type AvatarCreationRequest = {
  photoBuffer: Buffer;
  mimeType: string;
  /**
   * Verificado por la capa de producto ANTES de llegar aquí (ver
   * providers/avatar/types en el módulo de avatar) — el proveedor
   * también lo revisa como defensa en profundidad, nunca confía
   * únicamente en el llamador.
   */
  consentGiven: boolean;
};

export type AvatarCreationResult = {
  providerAvatarId: string;
  /** Presente si la creación/entrenamiento del avatar es asíncrona. */
  providerJobId?: string;
  status: AvatarJobStatus;
};

export type AvatarVideoRequest = {
  /** Persist the accepted job before polling or downloading; failure stops this attempt. */
  onJobCreated?: (providerJobId: string) => Promise<void>;
  providerAvatarId: string;
  /** Guion completo a narrar — HeyGen v3 limita esto a 5000 caracteres (ver docs/AVATAR_MODE.md). */
  script: string;
  /**
   * URL (ya alojada por ATOMIVID, p. ej. una URL firmada de Supabase
   * Storage de corta duración) de un audio YA sintetizado con nuestro
   * propio ElevenLabs — el flujo real del producto (voz consistente en
   * todos los videos, no la voz interna de cada proveedor). Cuando está
   * presente, el proveedor debe usarla en vez de sintetizar voz por su
   * cuenta (confirmado para D-ID: `script.type: "audio"` — ver
   * providers/avatar/did.ts). HeyGen también requiere audio externo; nunca activa TTS de respaldo.
   */
  audioUrl?: string;
  /** Duration measured from the actual audio bytes before submission. */
  audioDurationSeconds?: number;
  /** ID de voz PROPIO del proveedor — solo se usa cuando NO hay `audioUrl` (el proveedor sintetiza la voz él mismo). */
  voiceId?: string;
  language?: ScriptLanguage;
  maxCostUsd: number;
};

export type AvatarVideoResult = GenerativeAsset & { providerJobId: string };

/** Resultado de normalizar un payload de webhook del proveedor — null si el payload no tiene forma reconocible (nunca lanza por eso, ver heygen.ts). */
export type AvatarWebhookResult = {
  providerJobId: string;
  status: AvatarJobStatus;
};

export interface AvatarVideoProvider {
  readonly name: string;
  readonly capabilities: GenerativeCapabilities;
  isAvailable(): boolean;
  createAvatar(request: AvatarCreationRequest): Promise<AvatarCreationResult>;
  checkAvatarStatus(providerAvatarId: string): Promise<AvatarJobStatus>;
  generateVideo(request: AvatarVideoRequest): Promise<AvatarVideoResult>;
  checkVideoStatus(providerJobId: string): Promise<AvatarJobStatus>;
  /** Retrieve an existing result using GET only. Never creates a new job. */
  recoverVideo?(providerJobId: string): Promise<AvatarVideoResult>;
  /** Debe intentar borrar en el proveedor Y reportar honestamente si no se pudo confirmar (ver docs/AVATAR_MODE.md — DELETE no confirmado en fuentes disponibles). */
  deleteAvatar(providerAvatarId: string): Promise<{ deleted: boolean; reason?: string }>;
  /**
   * Estimación PURA (sin red) del costo antes de generar — para que la UI
   * y el pipeline puedan mostrar/verificar un costo sin gastar nada. Debe
   * ser la MISMA fórmula que generateVideo() usa internamente para
   * rechazar por presupuesto, nunca una aproximación distinta que podría
   * subestimar el gasto real.
   */
  estimateVideoCostUsd(request: Pick<AvatarVideoRequest, "script" | "audioDurationSeconds">): number;
  /** Debe intentar cancelar en el proveedor Y reportar honestamente si no se pudo confirmar — mismo criterio que deleteAvatar(). Nunca factura por cancelar. */
  cancelVideo(providerJobId: string): Promise<{ cancelled: boolean; reason?: string }>;
  /**
   * Normaliza un payload de webhook YA AUTENTICADO (la verificación de
   * autenticidad ocurre antes, en la ruta HTTP — ver
   * src/app/api/webhooks/avatar/[provider]/route.ts) a un resultado
   * estándar. Devuelve null (nunca lanza) si el payload no tiene la forma
   * esperada — un webhook malformado o de una versión distinta de la API
   * no debe tumbar el endpoint.
   */
  processWebhookPayload(payload: unknown): AvatarWebhookResult | null;
}
