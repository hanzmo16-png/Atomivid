"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";

type ContentType = "reel" | "avatar" | "long_form";

type Option = {
  type: ContentType;
  title: string;
  description: string;
  icon: ReactNode;
  href?: string;
};

const CARD_CLASS =
  "flex min-h-[112px] w-full flex-col items-start gap-1.5 rounded-lg border border-border-strong bg-surface-raised p-4 text-left transition-colors hover:border-accent-border hover:bg-accent-soft/40 focus-visible:outline-2 focus-visible:outline-accent";

const ICON_WRAP_CLASS =
  "flex size-9 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent";

function ReelIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M6 2a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2V4a2 2 0 00-2-2H6zm2 5.5l4.5 2.5L8 12.5v-5z" />
    </svg>
  );
}

function AvatarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 9a3.5 3.5 0 100-7 3.5 3.5 0 000 7zm-6 8a6 6 0 1112 0 1 1 0 01-1 1H5a1 1 0 01-1-1z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function DocumentaryIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M2 5a2 2 0 012-2h9a2 2 0 012 2v1.5l3-1.7a.75.75 0 011.13.65v8.1a.75.75 0 01-1.13.65l-3-1.7V14a2 2 0 01-2 2H4a2 2 0 01-2-2V5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

/**
 * Selector inicial "¿Qué quieres crear?" (RC QA polish, prioridad #2A).
 * NO duplica ningún formulario ni lógica: Reel revela el mismo
 * <NewVideoForm> que ya existía (pasado como children/prop desde
 * page.tsx, sin cambios), y Avatar/Documental navegan exactamente a las
 * mismas rutas (/dashboard/avatar/prepare, /dashboard/long-form/new) que
 * ya existían como LinkButton antes de este cambio — solo cambia cómo se
 * presentan (tarjetas parejas, sin solaparse en móvil) y que Reel ahora
 * también es una opción explícita del mismo selector, en vez de
 * mostrarse siempre por defecto debajo de unos botones descolgados.
 *
 * Si el usuario no tiene acceso ni a Avatar ni a Long Form (caso normal,
 * no-beta), no hay nada que elegir: se renderiza el formulario de Reel
 * directamente, exactamente igual que antes de este cambio.
 */
export function ContentTypeStep({
  reelForm,
  avatarAccess,
  longFormAccess,
}: {
  reelForm: ReactNode;
  avatarAccess: boolean;
  longFormAccess: boolean;
}) {
  const [selected, setSelected] = useState<ContentType | null>(null);

  if (!avatarAccess && !longFormAccess) {
    return <>{reelForm}</>;
  }

  if (selected === "reel") {
    return (
      <div>
        <button
          type="button"
          onClick={() => setSelected(null)}
          className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-ink-muted transition-colors hover:text-ink"
        >
          <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
            <path
              fillRule="evenodd"
              d="M12.7 4.3a1 1 0 010 1.4L9.42 9l3.3 3.3a1 1 0 01-1.42 1.4l-4-4a1 1 0 010-1.4l4-4a1 1 0 011.4 0z"
              clipRule="evenodd"
            />
          </svg>
          Elegir otro tipo de contenido
        </button>
        {reelForm}
      </div>
    );
  }

  const options: Option[] = [
    {
      type: "reel",
      title: "Reel / Short",
      description: "Video vertical 9:16 para TikTok, Reels o Shorts.",
      icon: <ReelIcon />,
    },
    ...(avatarAccess
      ? [
          {
            type: "avatar" as const,
            title: "Video con avatar",
            description: "Un presentador con IA narra tu guion. No consume créditos al preparar.",
            icon: <AvatarIcon />,
            href: "/dashboard/avatar/prepare",
          },
        ]
      : []),
    ...(longFormAccess
      ? [
          {
            type: "long_form" as const,
            title: "YouTube / Documental",
            description: "Video horizontal 16:9 largo, con fuentes verificadas. Beta.",
            icon: <DocumentaryIcon />,
            href: "/dashboard/long-form/new",
          },
        ]
      : []),
  ];

  return (
    <div>
      <p className="mb-3 text-sm font-semibold text-ink">¿Qué quieres crear?</p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {options.map((opt) =>
          opt.href ? (
            <Link key={opt.type} href={opt.href} className={CARD_CLASS}>
              <span className={ICON_WRAP_CLASS}>{opt.icon}</span>
              <span className="text-sm font-semibold text-ink">{opt.title}</span>
              <span className="text-xs text-ink-muted">{opt.description}</span>
            </Link>
          ) : (
            <button
              key={opt.type}
              type="button"
              onClick={() => setSelected(opt.type)}
              className={CARD_CLASS}
            >
              <span className={ICON_WRAP_CLASS}>{opt.icon}</span>
              <span className="text-sm font-semibold text-ink">{opt.title}</span>
              <span className="text-xs text-ink-muted">{opt.description}</span>
            </button>
          ),
        )}
      </div>
    </div>
  );
}
