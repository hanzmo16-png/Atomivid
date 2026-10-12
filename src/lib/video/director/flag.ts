/**
 * Off by default. Same truthy semantics as src/lib/video/feature-flags.ts (`1`, `true`, `yes`). Even when on,
 * the module only produces a proposal plan: nothing in the production pipeline reads it yet.
 */
export function cinematicDirectorV2Enabled(env: Record<string, string | undefined> = process.env): boolean {
  return ["1", "true", "yes"].includes((env.CINEMATIC_DIRECTOR_V2_ENABLED ?? "").trim().toLowerCase());
}
