import { createVideoRequest } from "./actions";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { ContentTypeStep } from "./ContentTypeStep";
import { getFeatureFlags } from "@/lib/video/feature-flags";
import { createClient } from "@/lib/supabase/server";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { canAccessLongFormBeta } from "@/lib/video/long-form/private-access";

const INCLUDES = [
  "Guion escrito por IA a partir de tu tema",
  "Narración con voz natural en el idioma que elijas",
  "Clips e imágenes reales por escena",
  "Música de fondo con licencia comercial",
  "Subtítulos incrustados automáticamente",
  "Video vertical 1080×1920, listo para descargar",
];

export default async function NewVideoPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const flags = getFeatureFlags();
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  const privateAvatarAccess = canPrepareAvatar(user);
  const longFormBetaAccess = canAccessLongFormBeta(user);
  // AVATAR_MODE_ENABLED es el interruptor GLOBAL de rollout (apagado en
  // producción a la fecha de este comentario — QA blocker real 2026-09-25:
  // la tarjeta "Video con avatar" desapareció del selector porque este
  // valor dependía de ESE flag Y del acceso privado a la vez). La cuenta
  // beta (canPrepareAvatar) debe poder ver y usar el modo avatar aunque el
  // flag global siga apagado — igual que la prueba D-ID legacy nunca
  // dependió de ese flag. Cuando AVATAR_MODE_ENABLED se encienda para
  // todos, esta misma expresión sigue siendo true para cualquier cuenta.
  const avatarModeUiEnabled = flags.avatarModeEnabled || privateAvatarAccess;

  let existingAvatars: { id: string; name: string }[] = [];
  if (privateAvatarAccess) {
    const supabase = await createClient();
    const { data } = await supabase
      .from("avatars")
      .select("id, name")
      // QA real (2026-09-25): sin este filtro, la lista mezclaba avatares
      // creados por proveedores distintos al configurado hoy (p. ej. "did",
      // de cuando esa era la prueba privada) — reusar uno de esos hacía
      // fallar la generación en pipeline.ts mucho más tarde (proveedor no
      // coincide), después de ya haber creado la solicitud. Solo se
      // ofrecen avatares del proveedor real y actual.
      .eq("provider", flags.avatarProvider)
      .eq("status", "ready")
      .order("created_at", { ascending: false });
    existingAvatars = data ?? [];
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold text-ink">Generar nuevo video</h1>
      <p className="mt-1 text-sm text-ink-muted">
        Describe el tema y revisa el guion antes de que se produzca el video final.
      </p>

      {error && (
        <Alert tone="danger" role="alert">
          <span className="[&::first-letter]:uppercase">{error.replaceAll("+", " ")}</span>
        </Alert>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card className="p-6">
          <ContentTypeStep
            createVideoRequestAction={createVideoRequest}
            avatarModeEnabled={avatarModeUiEnabled}
            existingAvatars={existingAvatars}
            // La tarjeta "Video con avatar" se ofrece a la cuenta beta
            // (privateAvatarAccess) sola — igual que siempre funcionó para
            // la prueba D-ID legacy — y avatarModeUiEnabled (arriba)
            // garantiza que, al abrirla, el toggle interno de NewVideoForm
            // SIEMPRE se renderiza para esa misma cuenta, sin depender del
            // flag global AVATAR_MODE_ENABLED.
            avatarAccess={privateAvatarAccess}
            longFormAccess={longFormBetaAccess}
          />
        </Card>

        <Card className="h-fit p-6">
          <p className="text-sm font-semibold text-ink">Tu video incluirá</p>
          <ul className="mt-4 space-y-2.5">
            {INCLUDES.map((item) => (
              <li key={item} className="flex items-start gap-2.5 text-sm text-ink-muted">
                <svg
                  className="mt-0.5 size-4 shrink-0 text-accent"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.7 5.3a1 1 0 010 1.4l-7.4 7.4a1 1 0 01-1.4 0L3.3 9.5a1 1 0 111.4-1.4l3.9 3.9 6.7-6.7a1 1 0 011.4 0z"
                    clipRule="evenodd"
                  />
                </svg>
                {item}
              </li>
            ))}
          </ul>
          <p className="mt-5 text-xs text-ink-faint">
            Al enviar, primero se genera el guion — podrás revisarlo y ajustarlo antes de
            producir el video final.
          </p>
        </Card>
      </div>
    </div>
  );
}
