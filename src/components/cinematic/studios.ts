/**
 * Cinematic UI 1.0 — tarjetas de estudios (lógica pura). Solo estudios que existen, con su ruta real y el mismo permiso
 * que ya usa el resto de la app (lo calcula el servidor y llega aquí como booleanos). Un estudio sin acceso se muestra
 * como «Disponible pronto para tu cuenta» y sin enlace: nunca como si funcionara.
 */
export type StudioId = "long-form" | "reels" | "podcast" | "audio-podcast" | "command-center";

export type Studio = {
  id: StudioId;
  title: string;
  tagline: string;
  href: string;
  available: boolean;
  /** Imagen propia de /public (o null → composición gráfica del propio estudio). */
  image: string | null;
  /** Cómo se compone la imagen: encuadre de cine 16:9, pantalla vertical 9:16 o foto a sangre. */
  art: "cinema" | "vertical" | "photo" | "panel";
  /** Solo para el dueño/administración: no se lista a clientes. */
  internal?: boolean;
};

export type StudioAccess = { longForm: boolean; podcast: boolean; audioStudio: boolean; commandCenter: boolean };

export const STUDIO_SOON = "Disponible pronto para tu cuenta";

export function studiosFor(access: StudioAccess): Studio[] {
  const list: Studio[] = [
    { id: "long-form", title: "Long Form Studio", tagline: "Documentales horizontales con guion investigado, narración y dirección visual.", href: "/dashboard/long-form/new", available: access.longForm, image: "/cinematic/cosmos-landscape-poster.jpg", art: "cinema" },
    { id: "reels", title: "Reels Studio", tagline: "Video vertical corto para TikTok, Reels y Shorts, listo para publicar.", href: "/dashboard/new?formato=reel", available: true, image: "/cinematic/cosmos-portrait-poster.jpg", art: "vertical" },
    { id: "podcast", title: "Podcast Studio", tagline: "Una o dos personas conversando en un estudio real, con avatar y música.", href: "/dashboard/podcast", available: access.podcast, image: "/cinematic/studio-moderno.jpg", art: "photo" },
    { id: "audio-podcast", title: "Audio Podcast Studio", tagline: "Episodios solo de audio con voces naturales, listos para escuchar.", href: "/dashboard/audio-studio", available: access.audioStudio, image: "/cinematic/studio-calido.jpg", art: "photo" },
  ];
  if (access.commandCenter) list.push({ id: "command-center", title: "Command Center", tagline: "Panel del dueño: estado de la plataforma, costos y cliente misterioso.", href: "/dashboard/command-center", available: true, image: null, art: "panel", internal: true });
  return list;
}
