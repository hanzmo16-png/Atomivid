"use client";

import { useActionState, useEffect, useState } from "react";
import { Button, LinkButton } from "@/components/ui/Button";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { PREPARATION_MAX_SECONDS } from "@/lib/video/avatar/private-access";
import { MAX_AVATAR_FORM_BYTES } from "@/lib/video/avatar/recording";
import { saveAvatarPreparation, connectSavedPreparation } from "./actions";

function useFilePreview() {
  const [url, setUrl] = useState<string>();
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  return [url, (file: File | null) => setUrl(file ? URL.createObjectURL(file) : undefined)] as const;
}

export function PreparationForm() {
  const [state, action, pending] = useActionState(saveAvatarPreparation, {});
  const [photo, setPhoto] = useState<File | null>(null);
  const [audio, setAudio] = useState<File | null>(null);
  const [duration, setDuration] = useState<number>();
  const [audioError, setAudioError] = useState(false);
  const [photoUrl, previewPhoto] = useFilePreview();
  const [audioUrl, previewAudio] = useFilePreview();
  const tooLarge = (photo?.size ?? 0) + (audio?.size ?? 0) > MAX_AVATAR_FORM_BYTES;
  const tooLong = duration !== undefined && duration > PREPARATION_MAX_SECONDS;
  if (state.saved) return <div role="status" className="space-y-4 rounded-lg border border-border-strong p-5">
    <h2 className="font-semibold">Solicitud privada preparada</h2>
    <p>No se ha generado ningún video. Tu audio se conserva completo, sin recortes ni otra voz.</p>
    <p>Duración verificada en el servidor: {state.seconds?.toFixed(3)} segundos. Puedes revisar la grabación antes de generar.</p>
    <LinkButton href={`/dashboard/review/${state.requestId}`}>Revisar grabación</LinkButton>
    <LinkButton href="/dashboard" variant="secondary">Volver al historial</LinkButton>
  </div>;
  return <form action={action} className="space-y-5 rounded-lg border border-border-strong p-5">
    <Field id="photo" label="Tu fotografía" hint="De frente, rostro visible. JPEG o PNG; mínimo 200 × 200 píxeles.">
      <input id="photo" name="photo" type="file" accept="image/jpeg,image/png" required className={INPUT_CLASS} onChange={e => { const file = e.target.files?.[0] ?? null; setPhoto(file); previewPhoto(file); }} />
    </Field>
    {photoUrl && <div className="flex justify-center">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={photoUrl} alt="Vista previa de tu fotografía" className="max-h-64 rounded-md object-contain" /></div>}
    <Field id="audio" label="Tu grabación original" hint="M4A, MP3 o WAV, hasta 45 segundos. Foto y audio: máximo 3 MB en total.">
      <input id="audio" name="audio" type="file" accept="audio/mp4,audio/x-m4a,audio/mpeg,audio/wav,.m4a,.mp3,.wav" required className={INPUT_CLASS} onChange={e => { const file = e.target.files?.[0] ?? null; setAudio(file); previewAudio(file); setDuration(undefined); setAudioError(false); }} />
    </Field>
    {audioUrl && <audio key={audioUrl} controls src={audioUrl} preload="metadata" className="w-full" aria-label="Escuchar mi grabación" onLoadedMetadata={e => { const value = e.currentTarget.duration; if (Number.isFinite(value) && value > 0) setDuration(value); else setAudioError(true); }} onError={() => setAudioError(true)} />}
    {duration !== undefined && <p>Duración de tu grabación: {duration.toFixed(2)} segundos. Se conservará completa.</p>}
    {(tooLarge || tooLong || audioError || state.error) && <p role="alert" className="text-sm text-danger">{tooLarge ? "Foto y audio superan 3 MB." : tooLong ? "La grabación supera 45 segundos. No se recortará automáticamente." : audioError ? "El navegador no pudo leer este audio. Prueba un archivo M4A o MP3." : state.error}</p>}
    <label className="flex gap-2 text-sm"><input type="checkbox" name="consent" required />Confirmo que la foto y la grabación son mías y autorizo guardarlas de forma privada para preparar esta prueba.</label>
    <p className="text-sm text-ink-muted">Guardar y revisar no consume saldo del proveedor. La generación es un paso separado y permanece restringida a esta prueba privada.</p>
    <Button type="submit" loading={pending} disabled={!photo || !audio || !duration || tooLarge || tooLong || audioError}>Guardar y continuar</Button>
  </form>;
}

export function SavedPreparationForm({ id, label }: { id: string; label: string }) {
  const [state, action, pending] = useActionState(connectSavedPreparation, {});
  return <form action={action} className="space-y-2 rounded-lg border border-border-strong p-4">
    <input type="hidden" name="preparationId" value={id} />
    <p>{label}</p>
    {state.saved ? <div role="status"><p>Grabación preparada: {state.seconds?.toFixed(3)} s. No se ha generado ningún video.</p><LinkButton href={`/dashboard/review/${state.requestId}`}>Revisar grabación</LinkButton></div>
      : <Button type="submit" loading={pending}>Continuar con estos archivos</Button>}
    {state.error && <p role="alert">{state.error}</p>}
  </form>;
}
