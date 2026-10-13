/**
 * Off by default. Same truthy semantics as src/lib/video/feature-flags.ts (`1`, `true`, `yes`). Even when on,
 * the module only produces a proposal plan: nothing in the production pipeline reads it yet.
 */
export function cinematicDirectorV2Enabled(env: Record<string, string | undefined> = process.env): boolean {
  return ["1", "true", "yes"].includes((env.CINEMATIC_DIRECTOR_V2_ENABLED ?? "").trim().toLowerCase());
}

/**
 * Off by default and independent from the inspection flag above. When on, the visual Reel render uses the Director
 * plan (recipes → per-scene motion, transitions, labels) on the material that was really resolved; a plan that
 * cannot be rendered honestly stops the render with an explicit error instead of silently falling back.
 */
export function cinematicDirectorRenderEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return ["1", "true", "yes"].includes((env.CINEMATIC_DIRECTOR_RENDER_ENABLED ?? "").trim().toLowerCase());
}
