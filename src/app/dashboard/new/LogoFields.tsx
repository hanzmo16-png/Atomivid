"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { INPUT_CLASS } from "@/components/ui/Field";

export function LogoFields() {
  const [enabled, setEnabled] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const { pending } = useFormStatus();
  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview); };
  }, [preview]);

  return (
    <fieldset disabled={pending} className="space-y-3 rounded-md border border-border-strong p-4">
      <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-ink">
        <input type="checkbox" name="include_logo" value="yes" checked={enabled}
          onChange={(event) => { setEnabled(event.target.checked); setPreview(null); }}
          className="size-4 accent-accent" />
        Incluir mi logo <span className="font-normal text-ink-muted">(opcional)</span>
      </label>
      {enabled && (
        <>
          <label htmlFor="brand_logo" className="block text-sm text-ink-muted">
            Se mostrará en la esquina superior izquierda durante todo el reel.
          </label>
          <input id="brand_logo" name="brand_logo" type="file" accept="image/png,.png" required
            className={`${INPUT_CLASS} max-w-full text-sm`} aria-describedby="logo-help"
            onChange={(event) => {
              const chosen = event.target.files?.[0] ?? null;
              const error = chosen && (chosen.type !== "image/png" || chosen.size > 1024 * 1024)
                ? "Selecciona un PNG de hasta 1 MB." : "";
              event.target.setCustomValidity(error);
              if (error) event.target.reportValidity();
              setPreview(!error && chosen ? URL.createObjectURL(chosen) : null);
            }} />
          <p id="logo-help" className="text-xs text-ink-muted">PNG de hasta 1 MB. Recomendamos fondo transparente.</p>
          {preview && <div className="inline-flex rounded-md bg-surface-raised p-3">
            <Image src={preview} alt="Vista previa de tu logo" width={160} height={96} unoptimized
              className="h-24 w-40 object-contain" />
          </div>}
        </>
      )}
    </fieldset>
  );
}
