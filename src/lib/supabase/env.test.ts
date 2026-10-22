import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { MissingEnvVarError } from "@/lib/env-errors";
import { getSupabaseAnonKey, getSupabaseUrl } from "./env";

const SRC = readFileSync(path.join(__dirname, "env.ts"), "utf8").replace(/^\s*\/\/.*$/gm, "");

test("las NEXT_PUBLIC_* de Supabase se leen con referencia literal (el bundler sólo inyecta esas en el navegador)", () => {
  assert.match(SRC, /process\.env\.NEXT_PUBLIC_SUPABASE_URL\b/);
  assert.match(SRC, /process\.env\.NEXT_PUBLIC_SUPABASE_ANON_KEY\b/);
  for (const m of SRC.matchAll(/readEnv\("(NEXT_PUBLIC_[A-Z_]+)"(\s*,\s*([^)]*))?\)/g)) {
    assert.equal(m[3]?.trim(), `process.env.${m[1]}`, `${m[1]} debe pasarse como process.env.${m[1]} literal`);
  }
});

test("valor presente: se devuelve recortado; ausente o vacío: MissingEnvVarError con el nombre", () => {
  const prev = { u: process.env.NEXT_PUBLIC_SUPABASE_URL, k: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
  try {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "  https://ejemplo.supabase.co ";
    assert.equal(getSupabaseUrl(), "https://ejemplo.supabase.co");
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "   ";
    assert.throws(() => getSupabaseAnonKey(), (e: unknown) => e instanceof MissingEnvVarError && e.varName === "NEXT_PUBLIC_SUPABASE_ANON_KEY");
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    assert.throws(() => getSupabaseUrl(), (e: unknown) => e instanceof MissingEnvVarError && e.varName === "NEXT_PUBLIC_SUPABASE_URL");
  } finally {
    if (prev.u === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = prev.u;
    if (prev.k === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = prev.k;
  }
});
