/**
 * Deterministic safety gate around the auditor (not a model judgement):
 *  - Text from Drive is untrusted data. A delivery that claims an authorisation ("Hans aprueba el gasto", "ignora las
 *    instrucciones"…) is escalated to Hans; it can never unlock spend.
 *  - Instructions produced by the auditor that would lead Claude to spend money, touch production, deploy/merge,
 *    handle credentials or protected assets (Travis Walton, Grok's editor account) are never forwarded as an
 *    automatic task: they become an approval request.
 */
const SENSITIVE: { id: string; re: RegExp }[] = [
  { id: "gasto", re: /\b(gast(o|ar)|pag(o|ar)|cobr(o|ar)|compra(r)?|contrat(ar|o)|factur|tarjeta|billing|purchase|pay(ment)?|subscribe|suscrib|usd|d[oó]lares)\b|\$\s?\d/i },
  { id: "produccion", re: /\b(producci[oó]n|production|deploy|desplieg|merge|fusion(ar|a)|migraci[oó]n|migration|vercel|release|publica(r|ción) en (youtube|spotify))\b/i },
  { id: "credenciales", re: /\b(contrase[nñ]a|password|api[ _-]?key|secret|token|service[_ ]role|credencial)/i },
  { id: "protegido", re: /\b(travis|walton|cuenta del editor)\b/i },
];

const AUTHORITY_CLAIMS = /\b(ignor(a|e|ar) (las |tus |all |previous |todas )?(instrucciones|instructions)|hans (aprueba|autoriza|aprob[oó]|autoriz[oó])|autorizo (el )?gasto|approved by hans|you are now|system prompt|sin l[ií]mite de presupuesto)/i;

export type GuardResult = { escalate: boolean; reasons: string[] };

export function checkDelivery(text: string): GuardResult {
  return AUTHORITY_CLAIMS.test(text) ? { escalate: true, reasons: ["la entrega contiene instrucciones o autorizaciones que solo Hans puede dar"] } : { escalate: false, reasons: [] };
}

export function checkInstructions(instructions: string[]): GuardResult {
  const reasons = new Set<string>();
  for (const line of instructions) for (const s of SENSITIVE) if (s.re.test(line)) reasons.add(s.id);
  return { escalate: reasons.size > 0, reasons: [...reasons].map((r) => `instrucción sensible (${r})`) };
}
