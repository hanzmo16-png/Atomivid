"use client";

import { useState } from "react";

/**
 * Per-video image source for a Reel. «Imágenes IA con Recraft» is an explicit choice: the style comes only from what
 * the user gives for THIS video (a saved Recraft style_id or 1-10 reference images). No house aesthetic is imposed.
 * Nothing is paid here; the server validates everything again (actions.ts).
 */
export function ReelImageSourcePicker({ format = "reel", disabled = false, onSourceChange }: {
  /** "reel": one image per scene (9:16). "long_form": the plan's AI images (16:9); archive footage stays as planned. */
  format?: "reel" | "long_form";
  disabled?: boolean;
  onSourceChange?: (source: "default" | "recraft") => void;
} = {}) {
  const [source, setSourceState] = useState<"default" | "recraft">("default");
  const setSource = (v: "default" | "recraft") => { setSourceState(v); onSourceChange?.(v); };
  const field = format === "reel" ? "reel_image_source" : "image_source";
  return (
    <fieldset className="space-y-2" disabled={disabled}>
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
          <label className="block">
            <span>Style ID de Recraft (opcional)</span>
            <input name="recraft_style_id" type="text" autoComplete="off" placeholder="Pega un style_id existente (no un request_id)" className="mt-1 w-full rounded border border-line px-2 py-1" />
          </label>
          <label className="block">
            <span>O sube de 1 a 10 imágenes de referencia de estilo (PNG, JPG o WEBP, máx. 5 MB c/u)</span>
            <input name="recraft_style_refs" type="file" multiple accept="image/png,image/jpeg,image/webp" className="mt-1 block" />
          </label>
          <label className="block">
            <span>Ajuste del estilo</span>
            <select name="recraft_style_match" defaultValue="" className="mt-1 rounded border border-line px-2 py-1">
              <option value="">Predeterminado</option>
              <option value="precise">Preciso</option>
              <option value="flexible">Flexible</option>
            </select>
          </label>
          <label className="block">
            <span>Si Recraft crea el estilo pero no devuelve su identificador (style_id)</span>
            <select name="recraft_style_missing" defaultValue="stop" className="mt-1 rounded border border-line px-2 py-1">
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
