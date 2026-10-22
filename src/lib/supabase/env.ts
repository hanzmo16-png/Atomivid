import { MissingEnvVarError } from "@/lib/env-errors";

// Lee y valida las variables de entorno de Supabase, con un error tipado
// que nombra exactamente cuál falta o está vacía — el error genérico de
// @supabase/supabase-js ("Your project's URL and Key are required...") no
// distingue cuál de las dos es la culpable ni por qué está vacía, y un
// Error genérico tampoco permite que el código que llama distinga este
// caso de cualquier otro fallo.
//
// Las NEXT_PUBLIC_* se leen con referencia LITERAL (process.env.NEXT_PUBLIC_X): el bundler de Next sólo sustituye esas
// en el código de navegador. Con process.env[name] el valor no se inyecta y en el navegador llegaba vacío, así que
// createClient() del cliente (subida de grabaciones de podcast, subida de curación) fallaba en producción.
function readEnv(name: string, raw: string | undefined = process.env[name]): string {
  const value = raw?.trim();
  if (!value) {
    throw new MissingEnvVarError(name);
  }
  return value;
}

export function getSupabaseUrl(): string {
  return readEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.NEXT_PUBLIC_SUPABASE_URL);
}

export function getSupabaseAnonKey(): string {
  return readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function getSupabaseServiceRoleKey(): string {
  return readEnv("SUPABASE_SERVICE_ROLE_KEY");
}
