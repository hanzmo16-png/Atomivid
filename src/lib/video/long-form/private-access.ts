import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { isInternalProductionOwner } from "@/lib/billing/internal-production";

type BetaUser = { id?: string; email?: string; email_confirmed_at?: string } | null;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

/**
 * Cuentas QA de Mystery Shopper autorizadas explícitamente (Hans, t900u): `BETA_QA_USER_IDS` = UUIDs separados por coma.
 * Vacío o ausente = nadie. Exige correo confirmado. NO son cuentas dueñas: no reciben voz demo ni derechos internos
 * (isInternalProductionOwner sigue siendo solo el dueño) y todos los topes de gasto siguen aplicando.
 */
export function isBetaQaUser(user: BetaUser, env: Record<string, string | undefined> = process.env): boolean {
  const ids = (env.BETA_QA_USER_IDS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s));
  return Boolean(ids.length && user?.email_confirmed_at && user.id && ids.includes(user.id.toLowerCase()));
}

/** Existing beta access plus the separately authorized internal Long Form account and explicit QA accounts. */
export function canAccessLongFormBeta(user: BetaUser, env: Record<string, string | undefined> = process.env): boolean {
  return canPrepareAvatar(user, env.AVATAR_PREPARATION_OWNER_EMAIL, env) || isInternalProductionOwner(user, env) || isBetaQaUser(user, env);
}
