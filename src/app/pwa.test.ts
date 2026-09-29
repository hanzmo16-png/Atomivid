/** PWA foundation: valid installable manifest; sensitive endpoints declared non-cacheable; no service worker. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import manifest from "./manifest";

test("manifest is valid and installable (name, start_url, standalone, 192 + 512 icons that exist)", () => {
  const m = manifest();
  assert.ok(m.name && m.short_name && m.start_url && m.display === "standalone");
  const sizes = (m.icons ?? []).map((i) => i.sizes);
  assert.ok(sizes.includes("192x192") && sizes.includes("512x512"));
  for (const i of m.icons ?? []) assert.ok(fs.existsSync(`public${i.src}`), `${i.src} exists`);
  assert.ok(m.theme_color && m.background_color);
});

test("sensitive endpoints are never cached and no service worker is registered", () => {
  const cfg = fs.readFileSync("next.config.ts", "utf8");
  for (const p of ["/api/admin/:path*", "/api/distribution/:path*"]) assert.ok(cfg.includes(`source: "${p}"`) && cfg.includes("private, no-store"), p);
  const route = fs.readFileSync("src/app/api/admin/command-center/route.ts", "utf8");
  assert.ok(route.includes("force-dynamic") && route.includes("private, no-store"));
  assert.ok(!fs.existsSync("public/sw.js") && !fs.existsSync("public/service-worker.js"));
  const layout = fs.readFileSync("src/app/layout.tsx", "utf8");
  assert.ok(!/serviceWorker\.register/.test(layout) && layout.includes("/manifest.webmanifest"));
});
