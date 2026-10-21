import { MissingEnvVarError } from "@/lib/env-errors";

// Lee y valida las variables de entorno de Supabase, con un error tipado
// que nombra exactamente cuál falta o está vacía — el error genérico de
// @supabase/supabase-js ("Your project's URL and Key are required...") no
// distingue cuál de las dos es la culpable ni por qué está vacía, y un
// Error genérico tampoco permite que el código que llama distinga este
// caso de cualquier otro fallo.
// Next.js solo sustituye en el bundle del navegador las referencias LITERALES `process.env.NEXT_PUBLIC_*`;
// `process.env[name]` queda vacío en el cliente (createClient() del navegador fallaba con «Falta la variable…»).
const PUBLIC_ENV: Record<string, string | undefined> = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
};

function readEnv(name: string): string {
  const value = (PUBLIC_ENV[name] ?? process.env[name])?.trim();
  if (!value) {
    throw new MissingEnvVarError(name);
  }
  return value;
}

export function getSupabaseUrl(): string {
  return readEnv("NEXT_PUBLIC_SUPABASE_URL");
}

export function getSupabaseAnonKey(): string {
  return readEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
}

export function getSupabaseServiceRoleKey(): string {
  return readEnv("SUPABASE_SERVICE_ROLE_KEY");
}
