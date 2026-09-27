import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import * as parsing from "./parse";

// Execute the actual server action with isolated I/O, never calling a paid API.
const compiled = ts.transpileModule(fs.readFileSync(new URL("./actions.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(options: { authenticated?: boolean; allowed?: boolean; generationFails?: boolean } = {}) {
  const generated: Array<{ language: string }> = [];
  const saved: Array<{ language: string; duration_seconds: number }> = [];
  const adapters: Record<string, unknown> = {
    "node:crypto": { randomUUID: () => "test-request" },
    "next/navigation": { redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } },
    "@/lib/supabase/server": { createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: options.authenticated === false ? null : { id: "test-owner" } } }) },
      from: () => ({ insert: async (row: { language: string; duration_seconds: number }) => { saved.push(row); return { error: null }; } }),
    }) },
    "@/lib/video/long-form/private-access": { canAccessLongFormBeta: () => options.allowed !== false },
    "@/lib/video/long-form/documentary-script": { generateDocumentaryScript: async (input: { language: string }) => {
      generated.push(input);
      if (options.generationFails) throw new Error("Fixture provider unavailable");
      return [{ narration: "Fixture narration" }];
    } },
    "./parse": parsing,
    "@/lib/video/render-error": { generateDiagnosticId: () => "test-diagnostic" },
  };
  const loadedAction = { exports: {} as { createLongFormVideoRequest: (form: FormData) => Promise<void> } };
  new Function("require", "module", "exports", compiled)((name: string) => {
    if (!(name in adapters)) throw new Error(`Unexpected dependency: ${name}`);
    return adapters[name];
  }, loadedAction, loadedAction.exports);
  return { action: loadedAction.exports.createLongFormVideoRequest, generated, saved };
}

function form(language?: string) {
  const data = new FormData();
  data.set("topic", "Deep ocean exploration");
  data.set("duration_minutes", "10");
  data.set("sources", "Fixture source | https://example.test/source");
  if (language !== undefined) data.set("language", language);
  return data;
}

test("English form generates and persists English; legacy form remains Spanish", async () => {
  for (const language of ["en", "es", undefined]) {
    const h = harness();
    await assert.rejects(h.action(form(language)), /REDIRECT:\/dashboard\?created=1/);
    assert.equal(h.generated[0].language, language ?? "es");
    assert.equal(h.saved[0].language, language ?? "es");
    assert.equal(h.saved[0].duration_seconds, 600);
  }
});

test("invalid language and unauthorized callers never reach generation or database writes", async () => {
  for (const options of [{}, { authenticated: false }, { allowed: false }]) {
    const h = harness(options);
    await assert.rejects(h.action(form("fr")), /REDIRECT:/);
    assert.deepEqual(h.generated, []);
    assert.deepEqual(h.saved, []);
  }
});

test("provider failure keeps English and submitted content in the recoverable form", async () => {
  const h = harness({ generationFails: true });
  await assert.rejects(h.action(form("en")), (error: Error) => {
    const url = new URL(error.message.replace("REDIRECT:", ""), "https://example.test");
    assert.equal(url.searchParams.get("language"), "en");
    assert.equal(url.searchParams.get("topic"), "Deep ocean exploration");
    assert.equal(url.searchParams.get("duration_minutes"), "10");
    return true;
  });
  assert.equal(h.saved.length, 0);
});
