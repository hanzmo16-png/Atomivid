/**
 * Cinematic UI 1.0 — galería «Producciones» (lógica pura). Se arma SOLO con producciones terminadas de la propia cuenta
 * (las filas ya pasaron el filtro por usuario/RLS y las URLs ya están firmadas en el servidor). No se inventan títulos,
 * géneros ni duraciones: el título es el tema real, el género sale del formato y estilo guardados, y la duración se
 * MIDE del archivo en el navegador (si no se pudo medir, no se muestra).
 */
export type ShowcaseSource = {
  id: string;
  mode?: string;
  topic: string;
  style: string;
  status: string;
  video_path: string | null;
  aspect_ratio?: string | null;
  created_at: string;
};

export type ShowcaseItem = {
  id: string;
  title: string;
  genre: string;
  vertical: boolean;
  url: string;
  href: string;
};

const MODE_LABEL: Record<string, string> = { long_form: "Documental", avatar: "Avatar", visual: "Reel" };

export function showcaseItems(rows: ShowcaseSource[], urlFor: (path: string) => string | null | undefined, max = 8): ShowcaseItem[] {
  const out: ShowcaseItem[] = [];
  for (const r of rows) {
    if (r.status !== "completed" || !r.video_path) continue;
    const url = urlFor(r.video_path);
    if (!url) continue;
    const mode = MODE_LABEL[r.mode ?? ""] ?? "Reel";
    const style = (r.style ?? "").trim();
    out.push({
      id: r.id,
      title: r.topic.trim() || "Sin título",
      genre: style && style.toLowerCase() !== mode.toLowerCase() ? `${mode} · ${style}` : mode,
      vertical: (r.aspect_ratio ?? "9:16") !== "16:9",
      url,
      href: `/dashboard/videos/${r.id}`,
    });
    if (out.length >= max) break;
  }
  return out;
}

/** Duración medida (segundos) en formato corto: 0:48, 12:05, 1:02:10. Sin medición válida → null (no se muestra). */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const s = Math.round(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}
