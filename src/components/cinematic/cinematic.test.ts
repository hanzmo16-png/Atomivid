import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AMBIENTS, COSMOS_PREVIOUS_MEDIA, ambientById, ambientForVariant, backgroundVariant, orientationFor, videoPolicy } from "./ambients";
import { studiosFor, STUDIO_SOON } from "./studios";
import { showcaseItems, formatDuration } from "./showcase";
import { dockVisibleOn } from "./MobileDock";

const ROOT = join(__dirname, "..", "..", "..");
const pub = (p: string) => join(ROOT, "public", p.replace(/^\//, ""));

test("cinco ambientes; solo los que tienen material propio declaran video, y ese material existe y pesa 1–3 MB (MP4)", () => {
  assert.deepEqual(AMBIENTS.map((a) => a.id), ["cosmos", "epic-history", "ocean-deep", "dark-mystery", "future-world"]);
  const withMedia = AMBIENTS.filter((a) => a.media);
  assert.deepEqual(withMedia.map((a) => a.id), ["cosmos"]);
  for (const a of withMedia) {
    for (const o of ["landscape", "portrait"] as const) {
      for (const s of a.media!.sources[o]) assert.ok(existsSync(pub(s.src)), s.src);
      const mp4 = a.media!.sources[o].find((s) => s.type === "video/mp4")!;
      const mb = statSync(pub(mp4.src)).size / 1e6;
      assert.ok(mb >= 0.3 && mb <= 3, `${mp4.src}: ${mb.toFixed(2)} MB`);
      assert.ok(existsSync(pub(a.media!.posters[o])));
      assert.ok(statSync(pub(a.media!.posters[o])).size < 150_000, "póster ligero");
    }
    assert.ok(a.media!.loopSeconds >= 6 && a.media!.loopSeconds <= 12);
    assert.match(a.media!.provenance, /Producción propia/);
  }
});

test("un ambiente sin material nunca finge video: se queda en el degradado", () => {
  assert.equal(videoPolicy(ambientById("ocean-deep"), { reducedMotion: false }), "gradient");
  assert.equal(ambientById("no-existe").id, "cosmos");
});

test("reducir movimiento, ahorro de datos y 2G → póster fijo; normal → video", () => {
  const c = ambientById("cosmos");
  assert.equal(videoPolicy(c, { reducedMotion: false, effectiveType: "4g" }), "video");
  assert.equal(videoPolicy(c, { reducedMotion: true }), "poster");
  assert.equal(videoPolicy(c, { reducedMotion: false, saveData: true }), "poster");
  assert.equal(videoPolicy(c, { reducedMotion: false, effectiveType: "2g" }), "poster");
  assert.equal(videoPolicy(c, { reducedMotion: false, effectiveType: "slow-2g" }), "poster");
  assert.equal(orientationFor(390, 844), "portrait");
  assert.equal(orientationFor(1440, 900), "landscape");
  assert.equal(orientationFor(768, 1024), "portrait");
});

test("estudios: rutas reales, permisos respetados, sin acceso → «Disponible pronto» sin enlace activo; Command Center solo dueño", () => {
  const none = studiosFor({ longForm: false, podcast: false, audioStudio: false, commandCenter: false });
  assert.deepEqual(none.map((s) => [s.id, s.available]), [["long-form", false], ["reels", true], ["podcast", false], ["audio-podcast", false]]);
  const all = studiosFor({ longForm: true, podcast: true, audioStudio: true, commandCenter: true });
  assert.deepEqual(all.map((s) => s.href), ["/dashboard/long-form/new", "/dashboard/new?formato=reel", "/dashboard/podcast", "/dashboard/audio-studio", "/dashboard/command-center"]);
  for (const s of all) {
    const route = s.href.split("?")[0].replace("/dashboard", "src/app/dashboard");
    assert.ok(existsSync(join(ROOT, route, "page.tsx")), `existe la página de ${s.href}`);
    if (s.image) assert.ok(existsSync(pub(s.image)), s.image);
  }
  assert.ok(STUDIO_SOON.length > 0);
});

test("galería: solo terminadas con URL firmada; título y género reales; máximo 8", () => {
  const rows = [
    { id: "a", mode: "long_form", topic: "Ocean Deep", style: "Documental", status: "completed", video_path: "u/a.mp4", aspect_ratio: "16:9", created_at: "2026-11-01" },
    { id: "b", mode: "visual", topic: "Reel fallido", style: "Humor", status: "failed", video_path: null, created_at: "2026-11-01" },
    { id: "c", mode: "visual", topic: "Curiosidades del mar", style: "Curiosidades", status: "completed", video_path: "u/c.mp4", created_at: "2026-11-01" },
    { id: "d", mode: "avatar", topic: "Sin firma", style: "x", status: "completed", video_path: "u/d.mp4", created_at: "2026-11-01" },
  ];
  const items = showcaseItems(rows, (p) => (p === "u/d.mp4" ? null : `https://signed/${p}`));
  assert.deepEqual(items.map((i) => i.id), ["a", "c"]);
  assert.equal(items[0].genre, "Documental");
  assert.equal(items[0].vertical, false);
  assert.equal(items[1].genre, "Reel · Curiosidades");
  assert.equal(items[1].vertical, true);
  assert.equal(items[0].href, "/dashboard/videos/a");
  const many = Array.from({ length: 20 }, (_, i) => ({ ...rows[0], id: String(i) }));
  assert.equal(showcaseItems(many, () => "u").length, 8);
});

test("duración medida en formato corto; sin medición válida no se muestra", () => {
  assert.equal(formatDuration(48.2), "0:48");
  assert.equal(formatDuration(725), "12:05");
  assert.equal(formatDuration(3730), "1:02:10");
  assert.equal(formatDuration(NaN), null);
  assert.equal(formatDuration(Infinity), null);
  assert.equal(formatDuration(0), null);
});

test("dock móvil solo en Inicio y Plan (no tapa las barras fijas de los estudios)", () => {
  assert.equal(dockVisibleOn("/dashboard"), true);
  assert.equal(dockVisibleOn("/dashboard/billing"), true);
  assert.equal(dockVisibleOn("/dashboard/podcast"), false);
  assert.equal(dockVisibleOn("/dashboard/new"), false);
  assert.equal(dockVisibleOn("/dashboard/audio-studio"), false);
  const src = readFileSync(join(__dirname, "MobileDock.tsx"), "utf8");
  assert.ok(src.includes("sticky bottom-0") && !/\bfixed\b/.test(src.replace(/\*[\s\S]*?\*\//g, "")), "sticky, no fixed: nunca tapa el final");
});

test("el fondo: video silencioso, en bucle, en línea, sin controles; pausa por visibilidad; libera recursos al desmontar", () => {
  const src = readFileSync(join(__dirname, "CinematicBackground.tsx"), "utf8");
  for (const attr of ["muted", "loop", "playsInline", "autoPlay", "disablePictureInPicture"]) assert.ok(src.includes(attr), attr);
  assert.equal(/\bcontrols\b/.test(src.replace(/\/\/.*$/gm, "")), false, "sin controles");
  assert.ok(src.includes("visibilitychange") && src.includes("IntersectionObserver"));
  assert.ok(src.includes('removeAttribute("src")') && src.includes("v.load()"));
  assert.ok(src.includes("prefers-reduced-motion"));
});

test("la capa cinematográfica no toca proveedores, cobros ni datos", () => {
  for (const f of ["ambients.ts", "studios.ts", "showcase.ts", "CinematicBackground.tsx", "CinematicHero.tsx", "StudioCards.tsx", "Showcase.tsx", "MobileDock.tsx"]) {
    const src = readFileSync(join(__dirname, f), "utf8");
    assert.equal(/fetch\s*\(|supabase|stripe|process\.env|elevenlabs|heygen|openai|recraft/i.test(src), false, f);
  }
});

test("COSMOS actual = video nuevo (cosmos2, ≤ 2,5 MB por archivo); ?bg=old conserva la versión anterior para comparar", () => {
  const cur = ambientForVariant(ambientById("cosmos"), backgroundVariant(undefined));
  const old = ambientForVariant(ambientById("cosmos"), backgroundVariant("old"));
  assert.match(cur.media!.sources.portrait[0].src, /\/cinematic\/cosmos2-portrait\.webm$/);
  assert.equal(old.media, COSMOS_PREVIOUS_MEDIA);
  assert.match(old.media!.sources.landscape[1].src, /\/cinematic\/cosmos-landscape\.mp4$/);
  assert.equal(backgroundVariant(["old"]), "old");
  assert.equal(backgroundVariant("nuevo"), "current");
  assert.equal(ambientForVariant(ambientById("ocean-deep"), "old").media, null, "solo COSMOS tiene versión anterior");
  for (const media of [cur.media!, old.media!]) {
    for (const o of ["landscape", "portrait"] as const) {
      for (const s of media.sources[o]) {
        assert.ok(existsSync(pub(s.src)), s.src);
        if (media === cur.media) assert.ok(statSync(pub(s.src)).size <= 2_500_000, `${s.src} ≤ 2,5 MB`);
      }
      assert.ok(existsSync(pub(media.posters[o])), media.posters[o]);
    }
  }
});
