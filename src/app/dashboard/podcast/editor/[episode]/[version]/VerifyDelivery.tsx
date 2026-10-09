"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";

type FileLinks = { archivo: string; bytes: number; play: string; download: string };
type Result = { status: { state: string; primary?: string | null; reason?: string }; files?: FileLinks[]; error?: string };

/** Runs the server-side sha256 check; playback and download appear only when every output verified. */
export function VerifyDelivery({ endpoint }: { endpoint: string }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  async function verify() {
    setLoading(true);
    try {
      const res = await fetch(endpoint, { method: "POST" });
      setResult(await res.json() as Result);
    } catch {
      setResult({ status: { state: "error" }, error: "No se pudo contactar al servidor." });
    } finally {
      setLoading(false);
    }
  }
  const primary = result?.files?.find((f) => f.archivo === result.status.primary) ?? null;
  return (
    <div className="mt-5 space-y-4">
      <Button onClick={verify} loading={loading}>{loading ? "Verificando…" : "Verificar integridad y abrir"}</Button>
      {result?.error && <p className="text-sm text-danger">{result.error}</p>}
      {result && !result.error && result.status.state !== "terminado" && (
        <p className="text-sm text-danger">No verificado: {result.status.state === "pendiente_verificar" ? "la verificación no terminó a tiempo; inténtalo de nuevo." : result.status.reason ?? result.status.state}</p>
      )}
      {result?.status.state === "terminado" && (
        <div className="space-y-3">
          <p className="text-sm text-success">Terminado: cada archivo coincide con COMPLETO.json (tamaño y sha256). Los enlaces caducan en 15 minutos.</p>
          {primary && (/\.(mp3|m4a|wav)$/i.test(primary.archivo)
            ? <audio controls preload="metadata" src={primary.play} className="w-full" />
            : <video controls preload="metadata" src={primary.play} className="w-full rounded-lg" />)}
          <ul className="grid gap-1 text-sm">
            {result.files?.map((f) => <li key={f.archivo}><a href={f.download} className="text-accent underline">Descargar {f.archivo}</a> · {(f.bytes / 1_048_576).toFixed(1)} MB</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
