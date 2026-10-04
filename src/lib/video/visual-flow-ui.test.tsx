import test from "node:test";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ScriptReview } from "@/app/dashboard/review/[id]/ScriptReview";
import type { GeneratedScript } from "@/lib/providers/types";

const legacy: GeneratedScript = { title: "Plan", segments: [{ text: "Mide las ventas.", visualQuery: "sales report" }] };
const planned: GeneratedScript = { ...legacy, segments: [{ ...legacy.segments[0], visualIntent: { source: "stock", subject: "business sales reports", mustShow: ["person analyzing sales reports"], mustNotShow: ["cryptocurrency trading"], imagePrompt: "Person analyzing business sales reports at a desk." } }] };
const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch() {} };
const html = (script: GeneratedScript, reviewedVisuals: boolean) => renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>
    <ScriptReview requestId="test" status="script_ready" initialScript={script} errorMessage={null} reviewedVisuals={reviewedVisuals} />
  </AppRouterContext.Provider>,
);
const finalButton = (markup: string) => markup.match(/<button[^>]*>Generar video final<\/button>/)?.[0];

test("reviewed reel with a missing plan visibly explains recovery and disables generation", () => {
  const markup = html(legacy, true);
  assert.match(markup, /La escena 1 necesita un plan visual actualizado/);
  assert.match(finalButton(markup)!, /\sdisabled(?:=|\s|>)/);
  assert.match(markup, /Regenerar esta escena/);
});
test("valid reviewed plans and rollout-off legacy scripts retain enabled generation", () => {
  for (const markup of [html(planned, true), html(legacy, false)]) {
    assert.doesNotMatch(finalButton(markup)!, /\sdisabled(?:=|\s|>)/);
    assert.doesNotMatch(markup, /necesita un plan visual actualizado/);
  }
});
