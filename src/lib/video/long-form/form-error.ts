import { DocumentaryResponseError } from "./json-response";
import { DocumentaryResearchError } from "./research";
import { EditorialQualityError } from "./editorial";
import { SupplyUnavailableError } from "@/lib/supply/policy";

/** Never send raw SDK JSON, ledger identifiers or database details to the form. */
export function documentaryFormError(error: unknown, diagnosticId: string): string {
  const suffix = ` (Código: ${diagnosticId})`;
  if (error instanceof SupplyUnavailableError) return error.customerMessage + suffix;
  if (error instanceof DocumentaryResponseError || error instanceof DocumentaryResearchError)
    return error.message + suffix;
  if (error instanceof EditorialQualityError)
    return "El guion no superó la revisión editorial. No se inició la producción audiovisual. Conservamos las respuestas recibidas para revisar el problema." + suffix;
  return "No se pudo completar el guion. Conservamos los campos y los avances registrados. No se inició la producción audiovisual; revisaremos el fallo antes de repetir una llamada." + suffix;
}
