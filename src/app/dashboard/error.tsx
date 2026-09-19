"use client";
import { Button, LinkButton } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
export default function DashboardError({ retry }: { retry: () => void }) {
  return <div className="space-y-4"><Alert tone="danger">No se pudo cargar esta pantalla. Tus solicitudes siguen guardadas. Volver a cargar no inicia una generación.</Alert>
    <div className="flex flex-wrap gap-3"><Button onClick={retry}>Volver a cargar</Button><LinkButton href="/dashboard" variant="secondary">Volver al historial</LinkButton></div>
  </div>;
}
