/**
 * «Mi voz» es un piloto de acceso controlado: además de MY_VOICE_ENABLED,
 * la cuenta debe estar en MY_VOICE_ALLOWLIST_EMAILS o
 * MY_VOICE_ALLOWLIST_USER_IDS (listas separadas por comas). Sin lista,
 * nadie tiene acceso. Se comprueba en la página, en el menú, en las
 * acciones y al listar voces privadas en los selectores.
 */
type EnvLike = Record<string, string | undefined>;

const list = (raw: string | undefined) =>
  new Set(
    (raw ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

export function canUseMyVoice(user: { id?: string | null; email?: string | null } | null | undefined, env: EnvLike = process.env): boolean {
  if (!user) return false;
  const enabled = ["1", "true", "yes"].includes((env.MY_VOICE_ENABLED ?? "").trim().toLowerCase());
  if (!enabled) return false;
  const ids = list(env.MY_VOICE_ALLOWLIST_USER_IDS);
  const emails = list(env.MY_VOICE_ALLOWLIST_EMAILS);
  return Boolean((user.id && ids.has(user.id.toLowerCase())) || (user.email && emails.has(user.email.toLowerCase())));
}
