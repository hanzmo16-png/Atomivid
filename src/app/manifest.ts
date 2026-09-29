import type { MetadataRoute } from "next";

// PWA foundation: installable metadata only. No service worker, no offline production,
// nothing cached (admin APIs, tokens, balances and customer data must never be cached).
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Atomivid",
    short_name: "Atomivid",
    description: "Atomivid — producción de video con IA y centro de mando del administrador.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#111827",
    theme_color: "#111827",
    lang: "es",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
  };
}
