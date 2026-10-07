import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSupplyInbox, presentSupplyAlert } from "@/lib/command-center/supply-alerts";
import { SupplyAlertsView } from "./SupplyAlertsView";

const env = { COMMAND_CENTER_ADMIN_EMAILS: "admin@example.test" };
const admin = { email: "admin@example.test", email_confirmed_at: "2026-10-01" };
test("denies ordinary users before querying private alerts", async () => {
  let reads = 0;
  const client = { from() { reads++; throw Error("unexpected read"); } } as unknown as SupabaseClient;
  await assert.rejects(loadSupplyInbox({ email: "other@example.test", email_confirmed_at: "2026-10-01" }, client, env), /owner\/admin/);
  assert.equal(reads, 0);
});
test("database failure is shown as unavailable rather than a healthy empty inbox", async () => {
  const client = { from() { throw Error("private database detail"); } } as unknown as SupabaseClient;
  const inbox = await loadSupplyInbox(admin, client, env);
  const html = renderToStaticMarkup(<SupplyAlertsView inbox={inbox} window="7D" />);
  assert.match(html, /No se pudieron consultar/);
  assert.doesNotMatch(html, /private database detail|No hay avisos registrados/);
});
test("renders only allowed alert details and labels old notices as historical", () => {
  const alert = presentSupplyAlert({ id: "alert-1", provider: "elevenlabs", level: "YELLOW", created_at: "2026-10-05T20:00:00Z", payload: { reason: "reported_wallet_low", secret: "do-not-render", url: "https://private.test" } });
  const html = renderToStaticMarkup(<SupplyAlertsView inbox={{ available: true, alerts: [alert] }} window="7D" />);
  assert.match(html, /ElevenLabs/); assert.match(html, /Saldo bajo al registrarse/);
  assert.match(html, /no confirma el saldo actual/); assert.match(html, /15:00/);
  assert.doesNotMatch(html, /do-not-render|private.test/);
  assert.equal(presentSupplyAlert({ id: "bad", level: "GREEN", created_at: "invalid" }).level, "UNKNOWN");
});
