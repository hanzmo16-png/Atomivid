"use client";

/** Anfitrión del catálogo tal como lo ve la página (enlaces firmados de su foto, recorte y muestra de voz). */
export type HostCard = { id: string; name: string; role: string; description: string; voiceName: string; photoUrl: string | null; sampleUrl: string | null };

/**
 * Selector de anfitriones (ampliable): foto, nombre, descripción y muestra de voz. Elegir uno carga su voz y su avatar;
 * «Otro / personalizado» mantiene la configuración propia (tu avatar y tu voz, por separado).
 */
export function HostPicker({ label, hosts, selected, onSelect, onCustom, disabledIds = [] }: {
  label: string; hosts: HostCard[]; selected: string | null; onSelect: (id: string) => void; onCustom: () => void; disabledIds?: string[];
}) {
  return (
    <fieldset className="grid min-w-0 gap-2" role="radiogroup" aria-label={label}>
      <legend className="px-1 text-sm font-medium text-ink">{label}</legend>
      <div className="grid min-w-0 gap-2 sm:grid-cols-3">
        {hosts.map((h) => {
          const on = selected === h.id, off = disabledIds.includes(h.id);
          return (
            <div key={h.id} className={`min-w-0 rounded-lg border p-2 text-left ${on ? "border-accent bg-surface" : "border-border"} ${off ? "opacity-50" : ""}`} data-testid={`anfitrion-${h.id}`}>
              <button type="button" role="radio" aria-checked={on} disabled={off} onClick={() => onSelect(h.id)} className="block w-full min-w-0 text-left">
                {h.photoUrl
                  // eslint-disable-next-line @next/next/no-img-element
                  ? <img src={h.photoUrl} alt={`Foto de ${h.name}`} className="aspect-[4/3] w-full rounded object-cover object-top" />
                  : <div className="aspect-[4/3] w-full rounded bg-surface-raised" />}
                <span className="mt-1 block font-medium text-ink">{h.name}</span>
                <span className="block text-xs text-ink-muted">{h.role} · voz {h.voiceName}</span>
                <span className="mt-1 block text-xs text-ink-muted">{h.description}</span>
              </button>
              {h.sampleUrl && <audio src={h.sampleUrl} controls preload="none" className="mt-1 w-full max-w-full" aria-label={`Muestra de voz de ${h.name}`} />}
            </div>
          );
        })}
      </div>
      <button type="button" role="radio" aria-checked={selected === null} onClick={onCustom} className={`rounded-lg border p-2 text-left text-sm ${selected === null ? "border-accent bg-surface" : "border-border"}`}>
        <span className="font-medium text-ink">Otro / personalizado</span> <span className="text-ink-muted">— nombre, voz y avatar a tu elección, incluido crear uno desde una foto (en los pasos siguientes)</span>
      </button>
    </fieldset>
  );
}
