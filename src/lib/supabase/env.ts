// Lee y valida las variables de entorno de Supabase, con un mensaje de
// error que nombra exactamente cuál falta o está vacía — el error genérico
// de @supabase/supabase-js ("Your project's URL and Key are required...")
// no distingue cuál de las dos es la culpable ni por qué está vacía.
function readEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Falta la variable de entorno "${name}" (o está vacía). Configúrala en Vercel → Settings → Environment Variables para el entorno Production y vuelve a desplegar.`,
    );
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
