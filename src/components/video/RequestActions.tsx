import { GenerateButton } from "@/app/dashboard/GenerateButton";
import { LinkButton } from "@/components/ui/Button";
import { requestAction } from "@/lib/video/request-action";
import type { VideoRequestSummary } from "@/lib/video/request-view";

/** History and result share the same actions and attempt restrictions. */
export function RequestActions({ request, nowMs }: { request: VideoRequestSummary; nowMs: number }) {
  const action = requestAction(request, nowMs);
  const review = `/dashboard/review/${request.id}`;
  if (action === "review") return <LinkButton href={review}>{request.mode === "avatar" ? "Revisar grabación" : "Revisar guion"}</LinkButton>;
  if (action === "script") return <GenerateButton endpoint={`/api/generate/${request.id}/script`} label="Generar guion" redirectTo={review} />;
  if (action === "retry") return <GenerateButton endpoint={`/api/generate/${request.id}/render`} label="Reintentar" redirectTo={`/dashboard/videos/${request.id}`} />;
  const message = action === "private-review" ? "La prueba privada requiere revisión antes de otro intento. No se reiniciará automáticamente."
    : action === "limit" ? "Se alcanzó el máximo de intentos. Puedes crear un video nuevo."
    : action === "access-review" ? "Se necesita revisar el acceso al servicio antes de volver a generar." : null;
  return message ? <p className="max-w-sm text-sm text-ink-muted">{message}</p> : null;
}
