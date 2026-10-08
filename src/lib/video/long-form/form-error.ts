import { EditorialEvidenceError } from "./editorial-evidence";
import { DocumentaryResponseError } from "./json-response";
import { DocumentaryResearchError } from "./research";
import { EditorialQualityError } from "./editorial";
import { LongFormScriptDurationError } from "./documentary-script";
import { SupplyUnavailableError } from "@/lib/supply/policy";
import { RecoveryBudgetExceededError } from "@/lib/supply/recovery-budget";

/** Never send raw SDK JSON, ledger identifiers or database details to the form. */
export function documentaryFormError(error: unknown, diagnosticId: string): string {
  const suffix = ` (Código: ${diagnosticId})`;
  if (error instanceof SupplyUnavailableError) return error.customerMessage + suffix;
  if (error instanceof RecoveryBudgetExceededError) return error.customerMessage + suffix;
  if (error instanceof DocumentaryResponseError || error instanceof DocumentaryResearchError)
    return error.message + suffix;
  if (error instanceof EditorialEvidenceError) return "El revisor no pudo respaldar sus observaciones con citas válidas. El guion sigue guardado, pendiente de revisión; no se inició la producción audiovisual." + suffix;
  if (error instanceof EditorialQualityError) {
    const repeated=error.reasons.some(r=>/^El bloque \d+ repite sin avanzar:/.test(r));
    return (repeated
      ? "El revisor señala un bloque que repite ideas sin hacer avanzar la historia. El guion necesita trabajo editorial; no es un fallo de acceso ni de créditos. "
      : "El guion mantiene observaciones editoriales pendientes. ") +
      (error.correctionExhausted ? "La corrección prevista ya se utilizó. " : "") +
      "Conservamos el borrador y sus observaciones en esta página; no iniciamos otra llamada ni la producción audiovisual." + suffix;
  }
  if (error instanceof LongFormScriptDurationError) return error.message + " Conservamos el borrador; no se inició la producción audiovisual." + suffix;
  return "No se pudo completar el guion. Conservamos los campos y los avances registrados. No se inició la producción audiovisual; revisaremos el fallo antes de repetir una llamada." + suffix;
}
