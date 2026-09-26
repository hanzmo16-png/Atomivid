"use client";

import { useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/Button";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { MAX_SAMPLE_BYTES, MAX_SAMPLE_SECONDS, MIN_SAMPLE_SECONDS, VOICE_CONSENT_TEXT, VOICE_NAME_MAX } from "@/lib/voices/sample";

function Submit({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} disabled={disabled} className="w-full" size="lg">
      {pending ? "Subiendo muestra…" : "Crear mi voz"}
    </Button>
  );
}

function measure(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      // Chrome informa Infinity en WEBM grabados hasta que se busca el final.
      if (audio.duration === Infinity) {
        audio.currentTime = 1e9;
        audio.ontimeupdate = () => {
          audio.ontimeupdate = null;
          URL.revokeObjectURL(url);
          resolve(Number.isFinite(audio.duration) ? audio.duration : null);
        };
        return;
      }
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(audio.duration) ? audio.duration : null);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    audio.src = url;
  });
}

/**
 * Crear «Mi voz»: grabar en el navegador o subir un archivo, con
 * consentimiento explícito. La duración medida aquí es orientativa; el
 * servidor valida formato y tamaño y el worker vuelve a medir la duración.
 */
export function VoiceForm({ action, clientRequestId }: { action: (formData: FormData) => void; clientRequestId: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [size, setSize] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [micError, setMicError] = useState<string | null>(null);
  const [consents, setConsents] = useState({ own: false, processing: false });

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => {
      const s = (Date.now() - started) / 1000;
      setElapsed(s);
      if (s >= MAX_SAMPLE_SECONDS) recorderRef.current?.stop();
    }, 250);
    return () => clearInterval(timer);
  }, [recording]);

  async function selectFile(file: File | null) {
    if (preview) URL.revokeObjectURL(preview);
    setPreview(file ? URL.createObjectURL(file) : null);
    setSize(file?.size ?? 0);
    setSeconds(file ? await measure(file) : null);
  }

  async function startRecording() {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const type = recorder.mimeType || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
        const file = new File(chunks, `grabacion.${ext}`, { type });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        if (fileRef.current) fileRef.current.files = transfer.files;
        await selectFile(file);
      };
      recorderRef.current = recorder;
      recorder.start(1000);
      setElapsed(0);
      setRecording(true);
    } catch {
      setMicError("No se pudo usar el micrófono. Revisa el permiso del navegador o sube un archivo.");
    }
  }

  const durationIssue =
    seconds === null ? null : seconds < MIN_SAMPLE_SECONDS ? `Dura ${Math.round(seconds)} s: necesita al menos ${MIN_SAMPLE_SECONDS} s.` : seconds > MAX_SAMPLE_SECONDS ? `Dura ${Math.round(seconds)} s: el máximo es ${MAX_SAMPLE_SECONDS / 60} min.` : null;
  const sizeIssue = size > MAX_SAMPLE_BYTES ? `El archivo supera ${MAX_SAMPLE_BYTES / 1024 / 1024} MB.` : null;
  const ready = size > 0 && !durationIssue && !sizeIssue && consents.own && consents.processing && !recording;

  return (
    <form action={action} className="space-y-5">
      <input type="hidden" name="client_request_id" value={clientRequestId} />
      <input type="hidden" name="client_seconds" value={seconds ?? ""} />
      <Field id="voice-name" label="Nombre de la voz">
        <input id="voice-name" name="name" required maxLength={VOICE_NAME_MAX} className={INPUT_CLASS} placeholder="Ej.: Mi voz de podcast" />
      </Field>

      <div className="space-y-3 rounded-md border border-border bg-surface px-4 py-3 text-sm text-ink-muted">
        <p className="font-medium text-ink">Cómo lograr una buena muestra</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>Entre 1 y 3 minutos hablando con naturalidad (mínimo {MIN_SAMPLE_SECONDS} s).</li>
          <li>Un lugar silencioso, sin música, eco ni otras voces.</li>
          <li>El mismo tono con el que quieres que narre.</li>
        </ul>
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium text-ink">Muestra</p>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {recording ? (
            <Button type="button" variant="danger" onClick={() => recorderRef.current?.stop()}>
              Detener ({Math.floor(elapsed)} s)
            </Button>
          ) : (
            <Button type="button" variant="secondary" onClick={startRecording}>
              Grabar con el micrófono
            </Button>
          )}
          <span className="text-xs text-ink-faint">o sube un archivo (MP3, M4A, WAV, WEBM u OGG, hasta {MAX_SAMPLE_BYTES / 1024 / 1024} MB)</span>
        </div>
        <input
          ref={fileRef}
          name="sample"
          type="file"
          accept="audio/*,.mp3,.m4a,.wav,.webm,.ogg"
          className={INPUT_CLASS}
          onChange={(e) => selectFile(e.target.files?.[0] ?? null)}
        />
        {micError && <p className="text-sm text-danger">{micError}</p>}
        {preview && <audio controls src={preview} className="w-full" />}
        {seconds !== null && !durationIssue && <p className="text-xs text-ink-muted">Duración: {Math.round(seconds)} s</p>}
        {(durationIssue || sizeIssue) && (
          <p className="text-sm text-danger" role="alert">
            {durationIssue ?? sizeIssue}
          </p>
        )}
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink">Consentimiento</legend>
        <label className="flex gap-3 text-sm text-ink-muted">
          <input type="checkbox" name="consent_own_voice" required className="mt-0.5 size-4 accent-accent" checked={consents.own} onChange={(e) => setConsents((c) => ({ ...c, own: e.target.checked }))} />
          <span>{VOICE_CONSENT_TEXT.ownVoice}</span>
        </label>
        <label className="flex gap-3 text-sm text-ink-muted">
          <input type="checkbox" name="consent_processing" required className="mt-0.5 size-4 accent-accent" checked={consents.processing} onChange={(e) => setConsents((c) => ({ ...c, processing: e.target.checked }))} />
          <span>{VOICE_CONSENT_TEXT.processing}</span>
        </label>
        <label className="flex gap-3 text-sm text-ink-muted">
          <input type="checkbox" name="keep_sample" className="mt-0.5 size-4 accent-accent" />
          <span>Conservar mi grabación original después de crear la voz (si no, se borra al terminar).</span>
        </label>
      </fieldset>

      <Submit disabled={!ready} />
    </form>
  );
}
