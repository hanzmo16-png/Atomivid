import { test } from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { FinancePanel } from "./FinancePanel";
import { estimateObligations } from "@/lib/supply/obligations";

test("owner finance panel separates unknown cash, estimated production reserve and trial access", () => {
  const data = estimateObligations({ subscriptions: [{ user_id: "private-id", status: "trialing", price_id: null }], requests: [], holds: [], rates: { reel: null, avatar: null, longForm: null }, monthStart: "2026-10-01T00:00:00Z" });
  const html = renderToStaticMarkup(<FinancePanel data={data} />);
  assert.ok(html.includes("Dinero libre para publicidad")); assert.ok(html.includes("Sin verificar"));
  assert.ok(html.includes("plan sin verificar")); assert.ok(!html.includes("private-id"));
  assert.ok(html.includes("En prueba: 1"));
  assert.ok(renderToStaticMarkup(<FinancePanel data={null} />).includes("No se pudieron comprobar"));
});
