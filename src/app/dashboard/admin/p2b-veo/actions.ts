"use server";

import { createClient } from "@/lib/supabase/server";
import { isP2BAdmin } from "./access";
import type { P2BExecutionResult } from "@/lib/video/long-form/p2b-pillar-transport-execution";

export type RunP2BState = { kind: "idle" } | { kind: "unauthorized" } | { kind: "result"; result: P2BExecutionResult };

/**
 * Server Action invocada por el botón "Ejecutar prueba Veo" de
 * RunP2BForm.tsx — reutiliza la sesión de Supabase ya autenticada del
 * navegador (cookies, mismo mecanismo que cualquier otra página del
 * dashboard) en vez de un token administrativo separado: Hans solo
 * necesita estar logueado normalmente en ATOMIVID, nunca copiar/pegar
 * ningún secreto. Vuelve a validar `isP2BAdmin` aquí server-side (nunca
 * confía solo en el gate de la página) antes de delegar TODA la lógica de
 * seguridad/ejecución real a executeP2BPillarTransportVeoOnce() — nunca
 * duplicada, ver p2b-pillar-transport-execution.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- firma fija por useActionState (React), ninguno de los dos parámetros es necesario aquí.
export async function runP2BPillarTransportVeo(_previous: RunP2BState, _formData: FormData): Promise<RunP2BState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!isP2BAdmin(user)) return { kind: "unauthorized" };

  const { executeP2BPillarTransportVeoOnce } = await import("@/lib/video/long-form/p2b-pillar-transport-execution");
  const result = await executeP2BPillarTransportVeoOnce();
  return { kind: "result", result };
}
