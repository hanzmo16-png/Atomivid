import { createVideoRequest } from "./actions";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import { NewVideoForm } from "./NewVideoForm";
import { createClient } from "@/lib/supabase/server";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { VideoModeNav } from "@/components/video/VideoModeNav";

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
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  const privateAvatarAccess = canPrepareAvatar(user);

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

      {privateAvatarAccess && <VideoModeNav current="visual" />}
      <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card className="p-6">
          <NewVideoForm action={createVideoRequest} />
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
            Al continuar se guarda tu solicitud. Después podrás generar y revisar el guion
            antes de producir el video final.
          </p>
        </Card>
      </div>
    </div>
  );
}
