/**
 * Dirección pública a la que deben volver los enlaces que salen del sitio (correo de confirmación, Stripe).
 * Orden: rama de vista previa (el entorno de prueba de Stripe vive ahí) → NEXT_PUBLIC_SITE_URL → cabecera
 * Origin → localhost. Antes el registro solo usaba Origin: si el navegador no la enviaba, el enlace del
 * correo quedaba «null/auth/callback».
 */
export function resolveSiteUrl(env: Record<string, string | undefined>, origin: string | null | undefined): string {
  const branchUrl = env.VERCEL_ENV === "preview" ? env.VERCEL_BRANCH_URL?.trim() : undefined;
  if (branchUrl) return `https://${branchUrl}`;
  const envUrl = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (envUrl) return envUrl.replace(/\/+$/, "");
  const cleanOrigin = origin?.trim();
  if (cleanOrigin && cleanOrigin !== "null") return cleanOrigin.replace(/\/+$/, "");
  return "http://localhost:3000";
}
