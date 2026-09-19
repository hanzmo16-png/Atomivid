/** Provider details stay in the owner's private request, never rendered as raw HTML/text. */
export function renderFailureMessage(detail: string): string {
  if (/timeout|timed? out|no terminó a tiempo|tiempo de espera/i.test(detail)) {
    return "El video no terminó dentro del tiempo disponible. Tu solicitud y guion siguen guardados. Revisa el estado antes de iniciar otro intento.";
  }
  if (/429|rate.?limit|too many requests/i.test(detail)) {
    return "El servicio está atendiendo demasiadas solicitudes. Tu guion sigue guardado; espera unos minutos antes de volver a intentarlo.";
  }
  if (/401|403|credential|api.?key|permis|not.configured/i.test(detail)) {
    return "Un servicio de generación necesita revisión de acceso. Tu solicitud sigue guardada. Contacta al soporte; repetir ahora no resolverá el problema.";
  }
  if (/duraci[oó]n|duration|integridad|integrity/i.test(detail)) {
    return "La validación del contenido no pasó. Revisa la duración y los archivos antes de otro intento.";
  }
  return "No se pudo completar este intento. Tu solicitud sigue guardada. Revisa su estado y contacta al soporte si el problema continúa.";
}
