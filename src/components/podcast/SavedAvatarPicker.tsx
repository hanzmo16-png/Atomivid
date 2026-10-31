"use client";

/** Avatar ya listo en la cuenta (p. ej. el propio). `photoUrl`: enlace firmado de su foto, si aún existe. */
export type SavedAvatarCard = { id: string; name: string; photoUrl?: string | null };

/**
 * Avatares guardados de la cuenta, visibles junto al catálogo (no hay que descubrir «Personalizado» primero).
 * Elegir uno deja el anfitrión del catálogo y conserva el resto del episodio. Uno ya elegido por el otro participante
 * no se puede repetir.
 */
export function SavedAvatarPicker({ label, who, avatars, selected, onSelect, disabledIds = [] }: {
  label: string; who: string; avatars: SavedAvatarCard[]; selected: string | null; onSelect: (a: SavedAvatarCard) => void; disabledIds?: string[];
}) {
  if (!avatars.length) return <p className="text-xs text-ink-muted" data-testid={`sin-avatares-guardados-${who}`}>Aún no tienes avatares guardados listos. Puedes crear uno desde una foto con «Personalizado».</p>;
  return (
    <fieldset className="grid min-w-0 gap-2" role="radiogroup" aria-label={label} data-testid={`avatares-guardados-${who}`}>
      <legend className="px-1 text-sm font-medium text-ink">{label}</legend>
      <div className="grid min-w-0 grid-cols-2 gap-2 sm:grid-cols-3">
        {avatars.map((a) => {
          const on = selected === a.id, off = !on && disabledIds.includes(a.id);
          return (
            <button key={a.id} type="button" role="radio" aria-checked={on} disabled={off} onClick={() => onSelect(a)} data-testid={`avatar-guardado-${who}-${a.id}`}
              className={`min-w-0 rounded-lg border p-2 text-left ${on ? "border-accent bg-surface" : "border-border"} ${off ? "opacity-50" : ""}`}>
              {a.photoUrl
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={a.photoUrl} alt={`Foto de ${a.name}`} className="aspect-square w-full rounded object-cover object-top" />
                : <div className="flex aspect-square w-full items-center justify-center rounded bg-surface-raised text-2xl text-ink-muted" aria-hidden>{a.name.slice(0, 1).toUpperCase()}</div>}
              <span className="mt-1 block break-words font-medium text-ink">{a.name}</span>
              <span className="block text-xs text-ink-muted">{off ? "Ya lo usa el otro participante" : "Guardado en tu cuenta"}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
