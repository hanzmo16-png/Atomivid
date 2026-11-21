"use client";

import { createContext, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import {
  WIZARD_RECOVERY_KEY, applyFreshHomeEntry, cleanEntryIdea, entryScreenLabel, recoveryList, restorePreviousDraft,
  type DraftStore, type FreshEntryParams, type ParkedDraft,
} from "@/lib/podcast/v3/wizard";

/**
 * T-20261108-0415: `true` solo en el montaje en que esta URL acaba de crear la configuración nueva (`started`). El
 * asistente no la anuncia entonces como «borrador retomado» ni ofrece «Empezar uno nuevo» (lo que aparcaría la recién
 * creada). Recargar el mismo enlace o recuperar una configuración anterior vuelve a `false`.
 */
export const FreshEntryContext = createContext(false);

/** Aplica la entrada (idempotente por token) y lee la lista recuperable. `fresh` = esta lectura creó la configuración. */
export function freshEntrySnapshot(store: DraftStore, params: FreshEntryParams): { fresh: boolean; parked: ParkedDraft[] } {
  const fresh = applyFreshHomeEntry(store, params).started;
  return { fresh, parked: recoveryList(store.getItem(WIZARD_RECOVERY_KEY)) };
}

function parkedTitle(raw: string): string {
  try {
    const t = JSON.parse(raw)?.title;
    return typeof t === "string" ? t.trim().slice(0, 80) : "";
  } catch { return ""; }
}

type EntrySnap = { ready: boolean; parked: ParkedDraft[]; idea: string | null; fresh: boolean };
const SERVER_SNAP: EntrySnap = { ready: false, parked: [], idea: null, fresh: false };
const listeners = new Set<() => void>();
let cache: { sig: string; snap: EntrySnap } | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function publish(sig: string, snap: EntrySnap) {
  cache = { sig, snap };
  for (const listener of listeners) listener();
}

/**
 * Lee el borrador en el cliente y, si la URL es la entrada Personalizado, deja lista la configuración nueva antes de
 * que el asistente se monte. `applyFreshHomeEntry` es idempotente por token: repetir la lectura no vuelve a empezar.
 * En el servidor (y en la hidratación) todavía no hay borrador: se muestra el aviso y no se monta el asistente.
 */
function readClient(sig: string, params: FreshEntryParams): EntrySnap {
  if (cache?.sig === sig) return cache.snap;
  let parked: ParkedDraft[] = [];
  let fresh = false;
  try {
    ({ fresh, parked } = freshEntrySnapshot(window.localStorage, params));
  } catch { /* almacenamiento bloqueado: el asistente se muestra igual y no se borra nada */ }
  const snap: EntrySnap = {
    ready: true,
    parked,
    idea: params.modo === "personalizado" ? cleanEntryIdea(params.idea) || null : null,
    fresh,
  };
  cache = { sig, snap };
  return snap;
}

/**
 * La portada Personalizado llega con `modo=personalizado` y `entrada=nueva-…`. Sin esa señal no se escribe nada y el
 * asistente reanuda su borrador. La configuración anterior se aparca, no se borra.
 */
export function PodcastFreshEntry({ modo, entrada, idea, children }: FreshEntryParams & { children: ReactNode }) {
  const router = useRouter();
  const [epoch, setEpoch] = useState(0);
  const sig = `${modo ?? ""}\0${entrada ?? ""}\0${idea ?? ""}`;
  const snap = useSyncExternalStore(subscribe, () => readClient(sig, { modo, entrada, idea }), () => SERVER_SNAP);

  if (!snap.ready) {
    return <p className="mt-4 text-sm text-ink-muted" data-testid="podcast-entrada-preparando" aria-busy="true">Cargando el asistente…</p>;
  }

  return (
    <>
      {snap.idea && <p className="mt-3 text-sm text-ink" data-testid="podcast-idea-conservada">Tu idea quedó guardada para el paso de contenido: {snap.idea}</p>}
      {snap.parked.length > 0 && (
        <div className="mt-3 rounded-lg border border-border p-3 text-sm" data-testid="podcast-borrador-anterior">
          <p className="text-ink">Tienes {snap.parked.length === 1 ? "una configuración anterior" : `${snap.parked.length} configuraciones anteriores`} sin terminar. Recuperar una no borra la de ahora.</p>
          <div className="mt-2 flex flex-col items-start gap-2">
            {snap.parked.map((item, index) => {
              const label = entryScreenLabel(item.step);
              const title = parkedTitle(item.raw);
              return (
                <Button key={`${item.at}-${item.step}-${index}`} type="button" variant="secondary" size="sm" data-testid={index === 0 ? "podcast-recuperar-borrador" : `podcast-recuperar-borrador-${index}`} data-step={item.step}
                  onClick={() => {
                    const result = restorePreviousDraft(window.localStorage, { index });
                    if (!result.restored) return;
                    publish(sig, { ready: true, parked: recoveryList(window.localStorage.getItem(WIZARD_RECOVERY_KEY)), idea: null, fresh: false });
                    setEpoch((n) => n + 1);
                    router.replace("/dashboard/podcast", { scroll: false });
                  }}>
                  Recuperar configuración anterior (Paso {label.paso}: {label.name}{title ? ` — ${title}` : ""})
                </Button>
              );
            })}
          </div>
        </div>
      )}
      <FreshEntryContext.Provider value={snap.fresh}><div key={`${epoch}:${entrada ?? ""}`}>{children}</div></FreshEntryContext.Provider>
    </>
  );
}
