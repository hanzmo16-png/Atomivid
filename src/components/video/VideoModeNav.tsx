import Link from "next/link";

/** Only rendered with the existing server-side private owner gate. */
export function VideoModeNav({ current }: { current: "visual" | "avatar" }) {
  return <nav aria-label="Tipo de video" className="my-6 grid gap-3 sm:grid-cols-2">
    {([
      ["visual", "/dashboard/new", "Video normal", "Tema, guion, voz y clips."],
      ["avatar", "/dashboard/avatar/prepare", "Video con avatar", "Tu foto y tu grabación original. Prueba privada."],
    ] as const).map(([mode, href, title, description]) => <Link key={mode} href={href} aria-current={current === mode ? "page" : undefined}
      className={`rounded-lg border p-4 ${current === mode ? "border-accent bg-surface-raised" : "border-border hover:border-accent"}`}>
      <span className="block font-medium text-ink">{title}</span><span className="mt-1 block text-sm text-ink-muted">{description}</span>
    </Link>)}
  </nav>;
}
