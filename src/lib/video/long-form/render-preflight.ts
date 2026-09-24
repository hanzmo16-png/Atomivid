/**
 * Validación ESTÁTICA (sin renderizar, sin tocar red) de los inputs que
 * se le pasarían a renderLongFormDoc() — pensada para detectar un problema
 * estructural (huecos entre shots, subtítulos fuera de rango, audio
 * faltante) ANTES de gastar tiempo de render, y sobre todo antes de
 * malgastar assets que en modo real ya se pagaron (TTS/imágenes) en un
 * render que de todos modos iba a salir roto.
 *
 * Puro: solo lee los datos que se le pasan, no importa nada de Remotion.
 */

export type RenderPreflightIssue = {
  code:
    | "no_scenes"
    | "duration_invalid"
    | "missing_audio"
    | "gap_at_start"
    | "gap_between_scenes"
    | "overlap_between_scenes"
    | "gap_at_end"
    | "caption_out_of_bounds"
    | "no_captions";
  message: string;
};

const TOLERANCE_SEC = 0.5;

export function preflightRenderInput(input: {
  scenes: { id: string; startSeconds: number; endSeconds: number }[];
  captions: { startSeconds: number; endSeconds: number }[];
  durationSeconds: number;
  audioUrl: string;
}): RenderPreflightIssue[] {
  const issues: RenderPreflightIssue[] = [];

  if (!(input.durationSeconds > 0)) {
    issues.push({ code: "duration_invalid", message: `durationSeconds debe ser > 0 (recibido: ${input.durationSeconds})` });
  }
  if (!input.audioUrl) {
    issues.push({ code: "missing_audio", message: "audioUrl vacío — el render quedaría sin narración" });
  }
  if (input.scenes.length === 0) {
    issues.push({ code: "no_scenes", message: "no hay ninguna escena — el render quedaría en pantalla negra" });
    return issues; // sin escenas no tiene sentido seguir validando cobertura
  }
  if (input.captions.length === 0) {
    issues.push({ code: "no_captions", message: "no hay ningún subtítulo — revisar si es intencional" });
  }

  const sorted = [...input.scenes].sort((a, b) => a.startSeconds - b.startSeconds);

  if (sorted[0].startSeconds > TOLERANCE_SEC) {
    issues.push({
      code: "gap_at_start",
      message: `la primera escena (${sorted[0].id}) empieza en ${sorted[0].startSeconds}s, no en 0 — habría pantalla negra al inicio`,
    });
  }

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].startSeconds - sorted[i - 1].endSeconds;
    if (gap > TOLERANCE_SEC) {
      issues.push({
        code: "gap_between_scenes",
        message: `hueco de ${gap.toFixed(2)}s entre ${sorted[i - 1].id} y ${sorted[i].id} — habría pantalla negra`,
      });
    } else if (gap < -TOLERANCE_SEC) {
      issues.push({
        code: "overlap_between_scenes",
        message: `${sorted[i - 1].id} y ${sorted[i].id} se superponen ${(-gap).toFixed(2)}s`,
      });
    }
  }

  const last = sorted[sorted.length - 1];
  const tailGap = input.durationSeconds - last.endSeconds;
  if (tailGap > TOLERANCE_SEC) {
    issues.push({
      code: "gap_at_end",
      message: `la última escena (${last.id}) termina en ${last.endSeconds}s pero el video dura ${input.durationSeconds}s — habría pantalla negra al final`,
    });
  }

  for (const c of input.captions) {
    if (c.startSeconds < -TOLERANCE_SEC || c.endSeconds > input.durationSeconds + TOLERANCE_SEC) {
      issues.push({
        code: "caption_out_of_bounds",
        message: `subtítulo [${c.startSeconds}-${c.endSeconds}] cae fuera de [0, ${input.durationSeconds}]`,
      });
    }
  }

  return issues;
}

export class RenderPreflightFailedError extends Error {
  constructor(public readonly issues: RenderPreflightIssue[]) {
    super(`Render preflight falló con ${issues.length} problema(s):\n${issues.map((i) => `- [${i.code}] ${i.message}`).join("\n")}`);
    this.name = "RenderPreflightFailedError";
  }
}

/** Lanza RenderPreflightFailedError si hay algún problema estructural — se llama ANTES de bundle()/renderMedia() en render.ts. */
export function assertRenderInputValid(input: Parameters<typeof preflightRenderInput>[0]): void {
  const issues = preflightRenderInput(input);
  if (issues.length > 0) throw new RenderPreflightFailedError(issues);
}
