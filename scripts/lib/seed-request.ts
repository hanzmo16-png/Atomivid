/**
 * Lógica pura de scripts/seed-test-request.ts: resolución/validación de
 * inputs, decisión de proveedor de guion, y armado del payload a
 * insertar. Deliberadamente separado del archivo que toca Supabase para
 * poder probarlo con `node:test` sin credenciales ni red — ver
 * seed-request.test.ts.
 *
 * Nunca importa `../../src/lib/providers/script/real` (ni nada que
 * transitivamente construya `new Anthropic()` a nivel de módulo, como
 * `src/lib/ai/script.ts`) — la resolución del proveedor real se inyecta
 * como función (`resolveRealProvider`), así un test puede simular
 * "Claude resuelto" o "faltó la API key" sin tocar el SDK real.
 */

export type SeedLanguage = "es" | "en";
export type SeedMode = "real" | "fixture";

export const DEFAULT_TOPIC = "[PRUEBA AUTOMÁTICA] Validación técnica del worker de Atomivid";
export const DEFAULT_STYLE = "Educativo";
export const DEFAULT_DURATION_SECONDS = 30;
export const DEFAULT_LANGUAGE: SeedLanguage = "es";
export const DEFAULT_MODE: SeedMode = "fixture";

// Mismos topes que valida el resto de la app (server action de
// /dashboard/new y el CHECK de la migración 0007) — un video de prueba
// no debe poder saltárselos solo por crearse desde este script.
export const MAX_TOPIC_LENGTH = 500;
export const MAX_STYLE_LENGTH = 100;
export const MAX_DURATION_SECONDS = 120;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; reason: string };

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}
function fail<T>(reason: string): ValidationResult<T> {
  return { ok: false, reason };
}

/**
 * `undefined` (variable de entorno no configurada) usa el default — así
 * omitir todas las variables SEED_* se comporta igual que antes de
 * parametrizar este script. Un valor configurado pero vacío/solo
 * espacios se trata como error explícito, no como "usa el default en
 * silencio" — evita que un typo (p. ej. SEED_TOPIC="  ") pase
 * desapercibido.
 */
export function resolveTopic(raw: string | undefined): ValidationResult<string> {
  if (raw === undefined) return ok(DEFAULT_TOPIC);
  const trimmed = raw.trim();
  if (!trimmed) return fail("El tema no puede estar vacío ni contener solo espacios.");
  if (trimmed.length > MAX_TOPIC_LENGTH) {
    return fail(`El tema no puede superar ${MAX_TOPIC_LENGTH} caracteres (recibidos ${trimmed.length}).`);
  }
  return ok(trimmed);
}

export function resolveStyle(raw: string | undefined): ValidationResult<string> {
  if (raw === undefined) return ok(DEFAULT_STYLE);
  const trimmed = raw.trim();
  if (!trimmed) return fail("El estilo no puede estar vacío ni contener solo espacios.");
  if (trimmed.length > MAX_STYLE_LENGTH) {
    return fail(`El estilo no puede superar ${MAX_STYLE_LENGTH} caracteres (recibidos ${trimmed.length}).`);
  }
  return ok(trimmed);
}

export function resolveLanguage(raw: string | undefined): ValidationResult<SeedLanguage> {
  if (raw === undefined || raw === "") return ok(DEFAULT_LANGUAGE);
  if (raw === "es" || raw === "en") return ok(raw);
  return fail(`Idioma inválido: "${raw}" (debe ser "es" o "en").`);
}

export function resolveMode(raw: string | undefined): ValidationResult<SeedMode> {
  if (raw === undefined || raw === "") return ok(DEFAULT_MODE);
  if (raw === "real" || raw === "fixture") return ok(raw);
  return fail(`Modo inválido: "${raw}" (debe ser "real" o "fixture").`);
}

export function resolveDurationSeconds(raw: string | undefined): ValidationResult<number> {
  if (raw === undefined || raw.trim() === "") return ok(DEFAULT_DURATION_SECONDS);
  const value = Number(raw);
  if (!Number.isFinite(value)) return fail(`Duración inválida (no numérica): "${raw}".`);
  if (value <= 0) return fail(`Duración inválida: debe ser mayor a 0 (recibido ${value}).`);
  if (value > MAX_DURATION_SECONDS) {
    return fail(`Duración inválida: no puede superar ${MAX_DURATION_SECONDS}s (recibido ${value}).`);
  }
  return ok(value);
}

export type SeedEnvInput = {
  topic?: string;
  style?: string;
  language?: string;
  mode?: string;
  durationSeconds?: string;
};

export type ResolvedSeedInput = {
  topic: string;
  style: string;
  language: SeedLanguage;
  mode: SeedMode;
  durationSeconds: number;
};

/** Corre las 5 validaciones y se detiene en la primera que falle. */
export function resolveSeedInput(env: SeedEnvInput): ValidationResult<ResolvedSeedInput> {
  const topic = resolveTopic(env.topic);
  if (!topic.ok) return topic;
  const style = resolveStyle(env.style);
  if (!style.ok) return style;
  const language = resolveLanguage(env.language);
  if (!language.ok) return language;
  const mode = resolveMode(env.mode);
  if (!mode.ok) return mode;
  const durationSeconds = resolveDurationSeconds(env.durationSeconds);
  if (!durationSeconds.ok) return durationSeconds;

  return ok({
    topic: topic.value,
    style: style.value,
    language: language.value,
    mode: mode.value,
    durationSeconds: durationSeconds.value,
  });
}

export type MinimalScriptProvider = { name: string };

/**
 * Decide qué proveedor de guion usar. En modo "real" nunca cae en
 * silencio al fixture: si falta la API key o el proveedor resuelto no es
 * "anthropic", falla explícito.
 */
export async function resolveScriptProvider(
  mode: SeedMode,
  deps: {
    hasAnthropicKey: boolean;
    resolveRealProvider: () => Promise<MinimalScriptProvider> | MinimalScriptProvider;
    fixtureProvider: MinimalScriptProvider;
  },
): Promise<ValidationResult<MinimalScriptProvider>> {
  if (mode === "fixture") {
    return ok(deps.fixtureProvider);
  }
  if (!deps.hasAnthropicKey) {
    return fail('SEED_MODE=real pedido pero ANTHROPIC_API_KEY no está configurada.');
  }
  const provider = await deps.resolveRealProvider();
  if (provider.name !== "anthropic") {
    return fail(
      `SEED_MODE=real pedido pero el proveedor resuelto es "${provider.name}", no "anthropic" ` +
        "(revisa ANTHROPIC_API_KEY/SCRIPT_PROVIDER) — no se usa fixture en su lugar.",
    );
  }
  return ok(provider);
}

/** Payload exacto que se inserta en video_requests — función pura, sin tocar Supabase. */
export function buildVideoRequestInsert(input: {
  userId: string;
  topic: string;
  style: string;
  durationSeconds: number;
  language: SeedLanguage;
  script: unknown;
  renderWorker?: string;
}) {
  return {
    user_id: input.userId,
    topic: input.topic,
    style: input.style,
    duration_seconds: input.durationSeconds,
    language: input.language,
    status: "processing" as const,
    script_json: input.script,
    render_attempts: 0,
    render_started_at: new Date().toISOString(),
    render_worker: input.renderWorker ?? "github-actions-manual-test",
  };
}

/**
 * Ventana para la protección por mejor esfuerzo contra duplicados (ver
 * seedTestRequest) — cubre el caso típico de reintentar manualmente el
 * workflow justo después de un fallo. No es una garantía atómica: no hay
 * constraint UNIQUE en video_requests (agregarla requeriría una
 * migración), así que dos ejecuciones concurrentes en la misma fracción
 * de segundo podrían, en teoría, seguir creando dos filas.
 */
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export type ScriptGenerator = {
  name: string;
  generateScript: (input: {
    topic: string;
    style: string;
    durationSeconds: number;
    language: SeedLanguage;
  }) => Promise<unknown>;
};

export type SeedServiceDeps = {
  /** Devuelve el id del primer usuario existente, o null si no hay ninguno. */
  getFirstUserId: () => Promise<string | null>;
  /** Solo se llama si getFirstUserId devolvió null. */
  createInternalTestUser: () => Promise<string>;
  /** Devuelve el id de una solicitud reciente equivalente, o null si no hay ninguna. */
  findRecentDuplicate: (params: {
    userId: string;
    topic: string;
    sinceISO: string;
  }) => Promise<string | null>;
  /** Inserta la fila y devuelve su id — se llama como máximo una vez por ejecución. */
  insertVideoRequest: (payload: ReturnType<typeof buildVideoRequestInsert>) => Promise<string>;
  /** Inyectable para pruebas deterministas del cálculo de la ventana de duplicados. */
  now?: () => Date;
};

export type SeedOutcome = { requestId: string; reused: boolean; scriptProviderName: string };

/**
 * Orquesta la creación (o reutilización) de la solicitud de prueba, ya con
 * el input validado (`resolveSeedInput`) y el proveedor de guion resuelto
 * (`resolveScriptProvider`) — ambos pasos previos, hechos por el llamador.
 * Todas las dependencias que tocan Supabase están inyectadas, así que es
 * testeable con fakes en memoria (ver seed-request.test.ts) sin una
 * conexión real. `insertVideoRequest` se llama como máximo una vez: si
 * `findRecentDuplicate` encuentra una fila reciente, se reutiliza su id y
 * se retorna antes de llegar a generar el guion o insertar.
 */
export async function seedTestRequest(
  resolved: ResolvedSeedInput,
  scriptProvider: ScriptGenerator,
  deps: SeedServiceDeps,
): Promise<SeedOutcome> {
  const { topic, style, language, durationSeconds } = resolved;

  let userId = await deps.getFirstUserId();
  if (!userId) {
    userId = await deps.createInternalTestUser();
  }

  const now = deps.now ? deps.now() : new Date();
  const sinceISO = new Date(now.getTime() - DUPLICATE_WINDOW_MS).toISOString();
  const existingId = await deps.findRecentDuplicate({ userId, topic, sinceISO });
  if (existingId) {
    return { requestId: existingId, reused: true, scriptProviderName: scriptProvider.name };
  }

  const script = await scriptProvider.generateScript({ topic, style, durationSeconds, language });
  const payload = buildVideoRequestInsert({ userId, topic, style, durationSeconds, language, script });
  const requestId = await deps.insertVideoRequest(payload);

  return { requestId, reused: false, scriptProviderName: scriptProvider.name };
}
