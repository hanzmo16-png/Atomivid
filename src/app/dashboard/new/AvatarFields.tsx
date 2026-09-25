"use client";

import { useId, useRef, useState } from "react";
import { Field, INPUT_CLASS } from "@/components/ui/Field";
import { MAX_AVATAR_PHOTO_BYTES, MAX_RECORDING_BYTES } from "@/lib/video/avatar/recording";

// Lista PROVISIONAL — no viene de GET /v3/voices de HeyGen (no se pudo
// verificar sin cuenta real, ver docs/AVATAR_MODE.md). Se muestra como
// tal en la UI para no prometer opciones que no están confirmadas.
const PROVISIONAL_VOICES: Record<"es" | "en", { id: string; label: string }[]> = {
  es: [{ id: "default-es", label: "Voz predeterminada (español) — provisional" }],
  en: [{ id: "default-en", label: "Default voice (English) — provisional" }],
};

// Debe coincidir con MAX_AVATAR_TTS_TEXT_LENGTH en dashboard/new/actions.ts
// (la validación real, del lado del servidor) — este valor es solo para
// el contador de caracteres en pantalla.
const MAX_TTS_TEXT_LENGTH = 2000;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];

// Estimación de referencia — misma tarifa de referencia que
// providers/avatar/heygen.ts (HEYGEN_COST_USD_PER_SECOND), punto medio
// del rango reportado por fuentes secundarias. Nunca se presenta como un
// costo confirmado, solo como estimación previa a generar.
const REFERENCE_COST_USD_PER_SECOND = 0.04;
const REFERENCE_WORDS_PER_SECOND = 2.5;

export function AvatarFields({
  existingAvatars,
  language,
}: {
  existingAvatars: { id: string; name: string }[];
  /** Mismo idioma elegido arriba para la narración — el modo avatar no pide uno aparte, ver nota junto al <select> de voz. */
  language: "es" | "en";
}) {
  const [narrationSource, setNarrationSource] = useState("tts");
  const audioInputId = useId();
  const fileInputId = useId();
  const nameId = useId();
  const consentId = useId();
  const existingAvatarId = useId();

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  // El <select> de abajo empieza en defaultValue="" ("Subir una fotografía
  // nueva") sin importar si el usuario tiene avatares existentes — el
  // estado inicial debe coincidir con eso para no mostrar el desplegable
  // en "nueva foto" mientras el formulario internamente cree que se está
  // reusando un avatar existente.
  const [useExisting, setUseExisting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setFileError(null);
    setPreviewUrl(null);
    if (!file) return;

    if (!ALLOWED_TYPES.includes(file.type)) {
      setFileError("Formato no admitido — usa JPEG, PNG o WEBP.");
      e.target.value = "";
      return;
    }
    if (file.size > MAX_AVATAR_PHOTO_BYTES) {
      setFileError(`El archivo pesa demasiado (máximo ${Math.round(MAX_AVATAR_PHOTO_BYTES / 1024 / 1024)} MB).`);
      e.target.value = "";
      return;
    }
    // Validación real (magic bytes/dimensiones) ocurre en el servidor —
    // esto es solo para dar feedback inmediato, nunca sustituye esa
    // verificación.
    setPreviewUrl(URL.createObjectURL(file));
  }

  return (
    <div className="space-y-5 rounded-lg border border-border-strong bg-surface p-4">
      <p className="text-sm font-semibold text-ink">Avatar</p>

      {existingAvatars.length > 0 && (
        <Field id={existingAvatarId} label="Usa un avatar ya creado, o sube uno nuevo abajo">
          <select
            id={existingAvatarId}
            name="existing_avatar_id"
            className={INPUT_CLASS}
            defaultValue=""
            onChange={(e) => setUseExisting(e.target.value !== "")}
          >
            <option value="">Subir una fotografía nueva</option>
            {existingAvatars.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {!useExisting && (
        <>
          <Field id={fileInputId} label="Fotografía" hint={`JPEG, PNG o WEBP. Hasta ${Math.round(MAX_AVATAR_PHOTO_BYTES / 1024 / 1024)} MB.`}>
            <input
              ref={fileRef}
              id={fileInputId}
              name="avatar_photo"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className={INPUT_CLASS}
              onChange={handleFileChange}
              aria-describedby={fileError ? `${fileInputId}-error` : undefined}
            />
            {fileError && (
              <p id={`${fileInputId}-error`} role="alert" className="mt-1.5 text-xs text-danger">
                {fileError}
              </p>
            )}
          </Field>

          {previewUrl && (
            <div className="flex justify-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewUrl}
                alt="Vista previa de la fotografía subida"
                className="max-h-56 rounded-md border border-border-strong object-contain"
              />
            </div>
          )}

          <Field id={nameId} label="Nombre interno del avatar" hint="Solo para identificarlo en tu historial — nadie más lo verá.">
            <input id={nameId} name="avatar_name" type="text" required maxLength={80} className={INPUT_CLASS} placeholder="Ej: Mi avatar profesional" />
          </Field>
        </>
      )}

      <Field id="narration-source" label="Narración">
        <select id="narration-source" name="narration_source" value={narrationSource}
          onChange={e => setNarrationSource(e.target.value)} className={INPUT_CLASS}>
          <option value="tts">Generar voz desde el guion</option>
          <option value="recording">Grabar o subir mi voz</option>
          <option value="tts_text">Voz IA desde texto</option>
        </select>
      </Field>
      {narrationSource === "recording" && (
        <Field
          id={audioInputId}
          label="Tu audio"
          hint={`M4A, MP3 o WAV, hasta ${Math.round(MAX_RECORDING_BYTES / 1024 / 1024)} MB. En el móvil, tocar este campo también ofrece grabar directamente.`}
        >
          {/* Sin `capture`: en Android/iOS, un <input type=file accept=
             "audio/*"> ya ofrece "Grabar audio" Y "Elegir archivo" como
             opciones del mismo picker nativo (confirmado en QA real,
             2026-09-25) — `capture` forzaría solo grabar, quitando la
             opción de subir un archivo ya existente. Sin infraestructura
             nueva de grabación: el picker nativo del sistema ya cubre
             ambos casos con este único input. */}
          <input id={audioInputId} name="recorded_audio" type="file" required accept="audio/mp4,audio/x-m4a,audio/mpeg,audio/wav,.m4a,.mp3,.wav" className={INPUT_CLASS} />
          <p className="mt-2 text-xs text-ink-muted">No se generará otra voz. Revisaremos la duración del archivo antes de solicitar el video.</p>
        </Field>
      )}
      {narrationSource === "tts_text" && <TtsTextField />}
      {narrationSource === "tts" && <Field
        id="avatar-voice"
        label="Voz"
        hint="Usa el idioma elegido arriba. Lista provisional — la lista real depende de la cuenta de HeyGen, todavía no verificada."
      >
        <select
          id="avatar-voice"
          name="avatar_voice_id"
          className={INPUT_CLASS}
          // key fuerza que React reinicie la selección si cambia el idioma
          // (evita quedarse con un id de voz del idioma anterior).
          key={language}
          defaultValue={PROVISIONAL_VOICES[language][0]?.id}
        >
          {PROVISIONAL_VOICES[language].map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </Field>}

      <div className="rounded-md bg-surface-raised p-3 text-xs text-ink-muted">
        <p className="font-medium text-ink">Estimación de consumo</p>
        <p className="mt-1">
          Aproximadamente ${REFERENCE_COST_USD_PER_SECOND.toFixed(2)} USD por segundo de video (tarifa de referencia, no
          confirmada — ver AVATAR_MODE.md). Un guion de 30s narradas ronda los{" "}
          {Math.round(30 * REFERENCE_WORDS_PER_SECOND * REFERENCE_COST_USD_PER_SECOND * 100) / 100} USD.
        </p>
      </div>

      <div className="flex items-start gap-2.5">
        <input id={consentId} name="avatar_consent" type="checkbox" required className="mt-1 size-4 rounded border-border-strong" />
        <label htmlFor={consentId} className="text-xs text-ink-muted">
          Confirmo que soy el propietario de esta fotografía, o cuento con autorización verificable de la persona
          fotografiada, y doy mi consentimiento explícito para crear un avatar que anime su rostro y labios. Queda
          prohibido usar fotografías de terceros sin permiso, suplantación engañosa, figuras públicas o menores de
          edad.{" "}
          <a href="/terms#avatar-consent" target="_blank" rel="noreferrer" className="text-accent underline">
            Leer el texto completo del consentimiento
          </a>
          .
        </label>
      </div>
    </div>
  );
}

/**
 * Tercera fuente de audio ("Voz IA desde texto") — reutiliza el mismo
 * provider ElevenLabs ya usado por Reel para narración (ver
 * dashboard/new/actions.ts, rama narrationSource==="tts_text"), nunca un
 * pipeline TTS paralelo. Sin preview en el cliente: la síntesis real
 * ocurre en el servidor al enviar el formulario (cuesta dinero real, así
 * que nunca se dispara desde el navegador antes de eso). La selección de
 * voz de ElevenLabs no está parametrizada todavía en
 * VoiceProvider.synthesize() (ver src/lib/providers/types.ts) — se deja
 * fuera de este campo en vez de prometer una opción que no hace nada
 * (misma disciplina que "Lista provisional" para la voz de HeyGen).
 */
function TtsTextField() {
  const id = useId();
  const [text, setText] = useState("");
  return (
    <Field
      id={id}
      label="Texto a narrar"
      hint={`Se generará la voz con IA a partir de este texto. ${MAX_TTS_TEXT_LENGTH} caracteres como máximo.`}
    >
      <textarea
        id={id}
        name="avatar_tts_text"
        required
        rows={5}
        maxLength={MAX_TTS_TEXT_LENGTH}
        className={INPUT_CLASS}
        placeholder="Escribe o pega aquí el texto que quieres que narre tu avatar…"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="mt-1 text-right text-xs text-ink-muted">
        {text.length} / {MAX_TTS_TEXT_LENGTH}
      </p>
    </Field>
  );
}
