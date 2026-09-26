import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { AutoRefresh } from "../AutoRefresh";
import { ACTIVE_VOICE_STATUSES, VOICE_BUCKET } from "@/lib/voices/requests";
import { VoiceForm } from "./VoiceForm";
import { createMyVoice, deleteMyVoice, retryMyVoice } from "./actions";

type VoiceRow = {
  id: string;
  name: string;
  status: string;
  sample_path: string | null;
  sample_seconds: number | null;
  keep_sample: boolean;
  test_audio_path: string | null;
  needs_review: boolean;
  error_message: string | null;
  created_at: string;
};

const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  uploaded: { label: "En cola", tone: "info" },
  cloning: { label: "Clonando", tone: "warning" },
  testing: { label: "Probando", tone: "warning" },
  ready: { label: "Lista", tone: "success" },
  failed: { label: "Falló", tone: "danger" },
  deleting: { label: "Eliminando", tone: "neutral" },
};

export default async function MyVoicePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const flags = getFeatureFlags();
  if (!flags.myVoiceEnabled) notFound();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) notFound();
  const { error } = await searchParams;

  // RLS: solo las voces propias; las eliminadas no se muestran.
  const { data } = await supabase
    .from("user_voices")
    .select("id, name, status, sample_path, sample_seconds, keep_sample, test_audio_path, needs_review, error_message, created_at")
    .neq("status", "deleted")
    .order("created_at", { ascending: false });
  const voices = (data ?? []) as VoiceRow[];
  const activeCount = voices.filter((v) => (ACTIVE_VOICE_STATUSES as readonly string[]).includes(v.status)).length;
  const canCreate = activeCount < flags.maxUserVoicesPerUser;

  const service = createServiceClient();
  const testUrls = new Map<string, string>();
  await Promise.all(
    voices
      .filter((v) => v.test_audio_path)
      .map(async (v) => {
        const { data: signed } = await service.storage.from(VOICE_BUCKET).createSignedUrl(v.test_audio_path!, 3600);
        if (signed) testUrls.set(v.id, signed.signedUrl);
      }),
  );
  const busy = voices.some((v) => ["uploaded", "cloning", "testing", "deleting"].includes(v.status));

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <AutoRefresh active={busy} />
      <div>
        <h1 className="text-2xl font-bold text-ink">Mi voz</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Crea una voz privada a partir de una grabación tuya y úsala en tus videos y en Texto a voz. Solo tú puedes usarla. El resultado es una aproximación, no una copia perfecta.
        </p>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}

      {voices.length > 0 && (
        <ul className="space-y-3">
          {voices.map((voice) => {
            const status = STATUS[voice.status] ?? { label: voice.status, tone: "neutral" as BadgeTone };
            const testUrl = testUrls.get(voice.id);
            return (
              <li key={voice.id}>
                <Card className="space-y-3 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="font-medium text-ink">{voice.name}</p>
                      <p className="text-xs text-ink-faint">
                        {voice.sample_seconds ? `Muestra de ${Math.round(voice.sample_seconds)} s · ` : ""}
                        {voice.sample_path ? (voice.keep_sample ? "grabación original conservada" : "la grabación original se borrará al terminar") : "grabación original borrada"}
                      </p>
                    </div>
                    <Badge tone={status.tone}>{status.label}</Badge>
                  </div>
                  {voice.status === "ready" && testUrl && (
                    <div className="space-y-1">
                      <p className="text-xs text-ink-muted">Prueba corta:</p>
                      <audio controls preload="none" src={testUrl} className="w-full" />
                    </div>
                  )}
                  {voice.status === "failed" && voice.error_message && <p className="text-sm text-danger">{voice.error_message}</p>}
                  <div className="flex flex-wrap gap-2">
                    {voice.status === "failed" && !voice.needs_review && (
                      <form action={retryMyVoice}>
                        <input type="hidden" name="voice_id" value={voice.id} />
                        <Button type="submit" variant="secondary" size="sm">
                          Reintentar
                        </Button>
                      </form>
                    )}
                    {["ready", "failed", "uploaded"].includes(voice.status) && (
                      <form action={deleteMyVoice}>
                        <input type="hidden" name="voice_id" value={voice.id} />
                        <Button type="submit" variant="ghost" size="sm">
                          Eliminar voz y grabaciones
                        </Button>
                      </form>
                    )}
                  </div>
                  {voice.status === "ready" && (
                    <p className="text-xs text-ink-faint">Eliminarla no borra los videos ni los audios que ya generaste con ella.</p>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      {canCreate ? (
        <Card className="p-5 sm:p-6">
          <VoiceForm action={createMyVoice} clientRequestId={randomUUID()} />
        </Card>
      ) : (
        <Alert tone="info">
          {flags.maxUserVoicesPerUser === 1 ? "Ya tienes una voz propia." : `Ya tienes ${flags.maxUserVoicesPerUser} voces propias.`} Para crear otra, elimina la actual.
        </Alert>
      )}
    </div>
  );
}
