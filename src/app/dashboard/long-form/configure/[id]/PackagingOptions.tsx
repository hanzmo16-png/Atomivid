"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { CoverPreview } from "@/components/video/CoverPreview";
import { COVER_CANVAS, COVER_STYLE_IDS, COVER_STYLES, type CoverIssue } from "../../../../../../remotion/cover-rules";
import { toCoverSpec, type LongFormPackaging, type PackagingOption } from "@/lib/video/long-form/packaging";

type Key = keyof LongFormPackaging;

const COPY: Record<Key, { title: string; description: string; canvas: "video" | "thumbnail" }> = {
  cover: {
    title: "Portada de apertura",
    description: "Título grande sobre los primeros segundos del video (primer fotograma incluido). No tapa subtítulos ni rótulos.",
    canvas: "video",
  },
  thumbnail: {
    title: "Miniatura de YouTube",
    description: "Imagen 1280×720 con la misma identidad visual, lista para subir a YouTube. Se entrega junto al video.",
    canvas: "thumbnail",
  },
};

function OptionEditor({
  kind,
  option,
  disabled,
  onChange,
  onIssues,
}: {
  kind: Key;
  option: PackagingOption;
  disabled: boolean;
  onChange: (next: PackagingOption) => void;
  onIssues: (kind: Key, issues: CoverIssue[]) => void;
}) {
  const copy = COPY[kind];
  const rules = COVER_CANVAS[copy.canvas];
  const [issues, setIssues] = useState<CoverIssue[]>([]);
  const handleIssues = useCallback(
    (list: CoverIssue[]) => {
      setIssues(list);
      onIssues(kind, list);
    },
    [kind, onIssues],
  );
  const id = `packaging-${kind}`;
  return (
    <Card className="p-4">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          name={`${kind}_enabled`}
          checked={option.enabled}
          disabled={disabled}
          onChange={(e) => onChange({ ...option, enabled: e.target.checked })}
          className="mt-1 shrink-0"
        />
        <span className="min-w-0">
          <span className="block font-medium text-ink">{copy.title}</span>
          <span className="block text-sm text-ink-muted">{copy.description}</span>
        </span>
      </label>

      {option.enabled && (
        <div className="mt-4 flex flex-col gap-3">
          <fieldset className="flex flex-wrap gap-2" disabled={disabled}>
            <legend className="mb-1 w-full text-sm font-medium text-ink">Estilo</legend>
            {COVER_STYLE_IDS.map((style) => (
              <label
                key={style}
                title={COVER_STYLES[style].description}
                className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${option.style === style ? "border-accent-border bg-surface-raised text-ink" : "border-border text-ink-muted"}`}
              >
                <input type="radio" name={`${kind}_style`} value={style} checked={option.style === style} onChange={() => onChange({ ...option, style })} className="sr-only" />
                {COVER_STYLES[style].label}
              </label>
            ))}
          </fieldset>

          <div>
            <label htmlFor={`${id}-title`} className="text-sm font-medium text-ink">
              Título <span className="font-normal text-ink-faint">({option.title.replace(/\*/g, "").length}/{rules.maxTitleChars})</span>
            </label>
            <input
              id={`${id}-title`}
              type="text"
              value={option.title}
              maxLength={rules.maxTitleChars + 4}
              disabled={disabled}
              onChange={(e) => onChange({ ...option, title: e.target.value })}
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink"
            />
            <p className="mt-1 text-xs text-ink-faint">Rodea con * la palabra clave para resaltarla (p. ej. «Cavar una *montaña*»). Solo afirmaciones que el video sostenga.</p>
          </div>

          <div>
            <label htmlFor={`${id}-kicker`} className="text-sm font-medium text-ink">
              Antetítulo (opcional)
            </label>
            <input
              id={`${id}-kicker`}
              type="text"
              value={option.kicker ?? ""}
              maxLength={rules.maxKickerChars}
              disabled={disabled}
              onChange={(e) => onChange({ ...option, kicker: e.target.value })}
              className="mt-1 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink"
              placeholder="Tema o fechas, p. ej. «Canal de Panamá · 1881–1914»"
            />
          </div>

          <CoverPreview spec={toCoverSpec(option)} canvas={copy.canvas} onIssues={handleIssues} />
          {issues.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm" role="status">
              {issues.map((i) => (
                <li key={i.code} className={i.severity === "error" ? "text-danger" : "text-warning"}>
                  {i.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

/**
 * «Portada de apertura» y «Miniatura de YouTube»: opciones independientes
 * (ninguna, una o ambas). En los canales propios vienen activadas por
 * defecto. `onValidityChange` bloquea la confirmación mientras una opción
 * activada no sea legible; el servidor vuelve a validar al confirmar.
 */
export function PackagingOptions({
  value,
  onChange,
  onValidityChange,
  disabled,
  ownChannel,
}: {
  value: LongFormPackaging;
  onChange: (next: LongFormPackaging) => void;
  onValidityChange: (valid: boolean) => void;
  disabled: boolean;
  ownChannel: boolean;
}) {
  const [errors, setErrors] = useState<Record<Key, number>>({ cover: 0, thumbnail: 0 });
  const onIssues = useCallback(
    (kind: Key, issues: CoverIssue[]) => {
      setErrors((prev) => ({ ...prev, [kind]: issues.filter((i) => i.severity === "error").length }));
    },
    [],
  );
  const coverErrors = value.cover.enabled ? errors.cover : 0;
  const thumbErrors = value.thumbnail.enabled ? errors.thumbnail : 0;
  const valid = coverErrors === 0 && thumbErrors === 0;
  useEffect(() => {
    onValidityChange(valid);
  }, [valid, onValidityChange]);

  return (
    <section className="mt-6" aria-labelledby="packaging-heading">
      <h2 id="packaging-heading" className="text-sm font-medium text-ink">
        Presentación para YouTube
      </h2>
      <p className="mt-0.5 text-sm text-ink-muted">
        {ownChannel ? "En tus canales vienen activadas por defecto; puedes desactivar cualquiera." : "Opcional: pide una, ambas o ninguna."} No tienen costo de proveedores.
      </p>
      <div className="mt-3 grid gap-3">
        <OptionEditor kind="cover" option={value.cover} disabled={disabled} onChange={(cover) => onChange({ ...value, cover })} onIssues={onIssues} />
        <OptionEditor kind="thumbnail" option={value.thumbnail} disabled={disabled} onChange={(thumbnail) => onChange({ ...value, thumbnail })} onIssues={onIssues} />
      </div>
    </section>
  );
}
