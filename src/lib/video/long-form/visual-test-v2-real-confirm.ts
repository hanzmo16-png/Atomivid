/**
 * Único valor de confirmación aceptado en el body de
 * POST /api/long-form/visual-test-v2/real — mismo criterio que
 * LONG_FORM_REAL_RUN_CONFIRM en mode.ts: deliberadamente largo y
 * específico para que nada lo dispare por accidente.
 *
 * Aislado en su propio archivo (sin ningún otro import) para que el botón
 * cliente ("use client", DryRunButton.tsx/RealGenerateButton.tsx) pueda
 * importar ÚNICAMENTE este string sin arrastrar código server-only
 * (Supabase, el proveedor de OpenAI) al bundle del navegador.
 */
export const VISUAL_TEST_V2_REAL_CONFIRM_VALUE = "GENERATE_3_VISUAL_TEST_V2_IMAGES";
