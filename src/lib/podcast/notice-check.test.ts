import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { latestTest, MIN_GAP_MS, reception, sendDecision, testCode, testComment, TEST_MARKER, type BotComment } from "./notice-check";

const bot = (id: number, at: string, body = `@hanzmo16-png ${TEST_MARKER} NC-202610102200.`): BotComment => ({ id, body, created_at: at, user: { login: "github-actions[bot]" } });

test("prueba de avisos: texto genérico, sin enlaces ni datos; código determinista", () => {
  const code = testCode(new Date("2026-10-10T22:05:41Z"));
  assert.equal(code, "NC-202610102205");
  const body = testComment("hanzmo16-png", code);
  assert.match(body, /^@hanzmo16-png Prueba de aviso de Atomivid NC-202610102205\. .*👍/);
  assert.doesNotMatch(body, /https?:|token|sig=|[0-9a-f]{8}-[0-9a-f]{4}/i, "nothing private in a public repository");
  assert.throws(() => testComment("bad user!", code));
  assert.throws(() => testComment("hanzmo16-png", "NC-1"));
});

test("prueba de avisos: como máximo una cada 10 minutos; solo cuentan los comentarios de prueba del bot", () => {
  const now = new Date("2026-10-10T22:10:00Z");
  const human: BotComment = { id: 9, body: TEST_MARKER, created_at: "2026-10-10T22:09:00Z", user: { login: "hanzmo16-png" } };
  assert.deepEqual(sendDecision([human], now), { ok: true }, "a human comment with the marker is not a test");
  assert.equal(sendDecision([bot(1, new Date(now.getTime() - MIN_GAP_MS + 1000).toISOString())], now).ok, false);
  assert.equal(sendDecision([bot(1, new Date(now.getTime() - MIN_GAP_MS - 1000).toISOString())], now).ok, true);
  assert.equal(latestTest([bot(1, "2026-10-10T20:00:00Z"), bot(2, "2026-10-10T21:00:00Z"), bot(3, "2026-10-10T21:30:00Z", "Una producción está lista")])?.id, 2);
});

test("recepción: solo el 👍 del propietario confirma; emisión y recepción por separado", () => {
  const c = bot(1, "2026-10-10T22:00:00Z");
  assert.deepEqual(reception(c, [], "hanzmo16-png"), { emitted: true, received: false, reactedAt: null, secondsAfterEmission: null });
  const others = [{ content: "+1", created_at: "2026-10-10T22:00:10Z", user: { login: "someone" } }, { content: "heart", created_at: "2026-10-10T22:00:20Z", user: { login: "hanzmo16-png" } }];
  assert.equal(reception(c, others, "hanzmo16-png").received, false);
  const own = [...others, { content: "+1", created_at: "2026-10-10T22:01:30Z", user: { login: "Hanzmo16-png" } }];
  assert.deepEqual(reception(c, own, "hanzmo16-png"), { emitted: true, received: true, reactedAt: "2026-10-10T22:01:30Z", secondsAfterEmission: 90 });
});

test("flujo de prueba de avisos: manual, permisos mínimos, publica como el bot", () => {
  const wf = readFileSync(".github/workflows/notice-check.yml", "utf8");
  assert.match(wf, /on:\n\s+workflow_dispatch:/);
  assert.doesNotMatch(wf, /schedule:|repository_dispatch|push:/, "never automatic");
  assert.match(wf, /issues: write/);
  assert.doesNotMatch(wf, /contents: write|SUPABASE|OPENAI|ACTIONS_TOKEN/, "no app data, no owner token (the owner would not be notified)");
  assert.match(wf, /GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
});
