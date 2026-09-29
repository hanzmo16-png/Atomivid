/**
 * Visual QA harness for the Command Center (dev only): renders the REAL view from the REAL
 * service over in-memory scenarios, compiles the real Tailwind theme, and writes standalone
 * HTML files for headless-Chromium screenshots. Never touches a database or the network.
 * Usage: npx tsx scripts/command-center-visual-qa.ts <outDir>
 */
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { createElement } from "react";
import { CommandCenterView } from "../src/app/dashboard/command-center/CommandCenterView";
import { CommandCenterService } from "../src/lib/command-center/service";
import { memorySource, type MemoryData } from "../src/lib/command-center/sources";
import { buildViewModel } from "../src/lib/command-center/view-model";
import { RICH, EMPTY, MIGRATIONS_MISSING, PARTIAL, SERVICE_DOWN, NOW } from "../src/lib/command-center/fixtures";

async function main() {
  const out = process.argv[2] ?? "visual-qa";
  fs.mkdirSync(out, { recursive: true });
  const css = (await postcss([tailwind()]).process(fs.readFileSync("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") })).css;
  const owner = { id: "u", email: "owner@atomivid.test", email_confirmed_at: NOW };
  const scenarios: [string, MemoryData, boolean][] = [["rich", RICH, true], ["empty", EMPTY, false], ["migrations-missing", MIGRATIONS_MISSING, false], ["partial", PARTIAL, true], ["service-down", SERVICE_DOWN, false]];
  for (const [name, data, yt] of scenarios) {
    const svc = new CommandCenterService({ source: memorySource(data), env: { AVATAR_PREPARATION_OWNER_EMAIL: owner.email }, now: () => NOW });
    const overview = await svc.section(owner, "overview", "7D");
    const vm = buildViewModel({ data: overview.data as Parameters<typeof buildViewModel>[0]["data"], window: "7D", generatedAt: overview.generatedAt, youtubeConfigured: yt, pwaReady: true });
    const body = renderToStaticMarkup(createElement(CommandCenterView, { vm }));
    fs.writeFileSync(path.join(out, `${name}.html`), `<!doctype html><html lang="es" class="h-full antialiased"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>Command Center QA: ${name}</title><style>${css}</style></head><body class="min-h-full bg-canvas text-ink"><main class="mx-auto max-w-5xl px-4 py-8 sm:px-6">${body}</main><script>addEventListener("load",()=>{const de=document.documentElement;let widest=null,w=0;for(const el of document.querySelectorAll("*")){const r=el.getBoundingClientRect();if(r.right>w){w=r.right;widest=el;}}document.body.setAttribute("data-scroll-width",String(de.scrollWidth));document.body.setAttribute("data-client-width",String(de.clientWidth));document.body.setAttribute("data-widest",(widest&&widest.tagName+"."+(widest.className||"").toString().slice(0,60))||"");document.body.setAttribute("data-widest-right",String(Math.round(w)));});</script></body></html>`);
    console.log(`${name}: ${vm.overall.status}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
