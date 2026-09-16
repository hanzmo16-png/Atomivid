import { EmptyState } from "@/components/ui/EmptyState";
import { LinkButton } from "@/components/ui/Button";

export default function VideoNotFound() {
  return (
    <div className="mx-auto max-w-md">
      <EmptyState
        title="No encontramos ese video"
        description="No existe o no tienes acceso a esta solicitud."
        action={<LinkButton href="/dashboard">Volver al historial</LinkButton>}
      />
    </div>
  );
}
