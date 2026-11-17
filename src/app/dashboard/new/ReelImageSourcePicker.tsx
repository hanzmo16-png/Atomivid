"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isValidStyleId, recraftClientBlockMessage, type RecraftClientFile } from "@/lib/video/recraft-reel";

function listedFiles(input: HTMLInputElement | null): RecraftClientFile[] {
  return Array.from(input?.files ?? []).filter((f) => f.size > 0).map((f) => ({ type: f.type, size: f.size }));
}

/**
 * Per-video image source. On a Reel the initial choice is Material de archivo: Recraft is an explicit
 * choice for THIS video (a saved style or 1–10 reference images). No house aesthetic is imposed.
 * Nothing is paid here; the server validates everything again (actions.ts).
 *
 * Long Form reuses this picker and, when `defaultSource` is omitted, keeps its previous Recraft-first
 * initial value so ConfigureProduction's own state stays aligned. Passing `defaultSource` overrides that.
 */
export function ReelImageSourcePicker({ format = "reel", disabled = false, onSourceChange, defaultSource }: {
  /** "reel": one image per scene (9:16). "long_form": the plan's AI images (16:9); archive footage stays as planned. */
  format?: "reel" | "long_form";
  disabled?: boolean;
  onSourceChange?: (source: "default" | "recraft") => void;
  defaultSource?: "default" | "recraft";
} = {}) {
  const initialSource = defaultSource ?? (format === "long_form" ? "recraft" : "default");
  const [source, setSourceState] = useState<"default" | "recraft">(initialSource);
  const [inlineMessage, setInlineMessage] = useState("");
  const styleRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLInputElement>(null);
  const setSource = (v: "default" | "recraft") => {
    setSourceState(v);
    onSourceChange?.(v);
    if (v !== "recraft") setInlineMessage("");
  };
  const field = format === "reel" ? "reel_image_source" : "image_source";
  const ruleId = `${field}-recraft-rule`;
  const alertId = `${field}-recraft-block`;

  /** Writes the constraint on the control the browser should focus. Returns the message ("" if submittable). */
  const syncDom = useCallback((): string => {
    const style = styleRef.current;
    const files = filesRef.current;
    if (!style || !files) return "";
    const message = recraftClientBlockMessage(style.value, listedFiles(files));
    const id = style.value.trim();
    const count = listedFiles(files).length;
    const onStyle = message !== "" && ((id !== "" && !isValidStyleId(id)) || count === 0);
    style.setCustomValidity(onStyle ? message : "");
    files.setCustomValidity(!onStyle && message ? message : "");
    return message;
  }, []);

  function publish(announce: boolean) {
    const message = syncDom();
    setInlineMessage((current) => {
      if (announce) return message;
      if (!message) return "";
      return current ? message : current;
    });
  }

  useEffect(() => {
    if (source !== "recraft") return;
    syncDom();
  }, [source, syncDom]);

  return (
    <fieldset className="min-w-0 space-y-2" disabled={disabled}>
      <legend className="text-sm font-medium text-ink">{format === "reel" ? "Imágenes del Reel" : "Imágenes generadas por IA"}</legend>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" name={field} value="default" checked={source === "default"} onChange={() => setSource("default")} />
        {format === "reel" ? "Material de archivo (como hasta ahora)" : "Proveedor actual (como hasta ahora)"}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" name={field} value="recraft" checked={source === "recraft"} onChange={() => setSource("recraft")} />
        Imágenes IA con Recraft
      </label>
      {source === "recraft" && (
        <div className="space-y-2 rounded-md border border-line p-3 text-sm">
          <p className="text-ink-muted">
            {format === "reel"
              ? "Una imagen por escena con un estilo único para este video. Costo estimado: USD 0,035 por escena (+ USD 0,005 una vez si el estilo se crea desde tus imágenes)."
              : "Las imágenes IA del plan (horizontal 16:9) se crean con un estilo único para este documental. Costo estimado: USD 0,035 por imagen (+ USD 0,005 una vez si el estilo se crea desde tus imágenes); el plan de abajo ya lo incluye. El material de archivo y los clips de video previstos no cambian. Cada imagen se marca como recreación IA, nunca como registro histórico."}
            {" "}Si algo falla, el video se detiene con un aviso claro: nunca se sustituyen imágenes.
          </p>
          <p id={ruleId} className="font-medium text-ink">
            Elige una sola vía: indica un estilo guardado O sube de 1 a 10 imágenes de referencia.
          </p>
          <label className="block">
            <span>Identificador de estilo guardado</span>
            <input ref={styleRef} name="recraft_style_id" type="text" autoComplete="off" placeholder="Pega el identificador del estilo guardado" aria-describedby={inlineMessage ? `${ruleId} ${alertId}` : ruleId} className="mt-1 w-full rounded border border-line px-2 py-1" onChange={() => publish(false)} onBlur={() => publish(true)} onInvalid={() => publish(true)} />
            <span className="mt-1 block text-xs text-ink-muted">Un identificador de solicitud del proveedor no es un estilo guardado.</span>
          </label>
          <label className="block">
            <span>O sube de 1 a 10 imágenes de referencia de estilo (PNG, JPG o WEBP, máx. 5 MB c/u)</span>
            <input ref={filesRef} name="recraft_style_refs" type="file" multiple accept="image/png,image/jpeg,image/webp" aria-describedby={inlineMessage ? `${ruleId} ${alertId}` : ruleId} className="mt-1 block w-full min-w-0 max-w-full" onChange={() => publish(true)} onInvalid={() => publish(true)} />
          </label>
          {inlineMessage && <p id={alertId} role="alert" className="text-sm text-danger">{inlineMessage}</p>}
          <label className="block">
            <span>Ajuste del estilo</span>
            <select name="recraft_style_match" defaultValue="" className="mt-1 block w-full min-w-0 max-w-full rounded border border-line px-2 py-1">
              <option value="">Predeterminado</option>
              <option value="precise">Preciso</option>
              <option value="flexible">Flexible</option>
            </select>
          </label>
          <label className="block">
            <span>Si Recraft crea el estilo pero no devuelve su identificador</span>
            <select name="recraft_style_missing" defaultValue="stop" className="mt-1 block w-full min-w-0 max-w-full rounded border border-line px-2 py-1">
              <option value="stop">Detener y conservar la imagen pagada (recomendado)</option>
              <option value="same_references">Continuar con las mismas referencias (hasta USD 0,005 más por imagen; el plan ya lo cubre)</option>
            </select>
          </label>
          <label className="block">
            <span>Nota de estilo (opcional, tus palabras)</span>
            <input name="recraft_style_note" type="text" maxLength={300} className="mt-1 w-full rounded border border-line px-2 py-1" />
          </label>
        </div>
      )}
    </fieldset>
  );
}
