// Stripe SIMULADO (modo prueba) para el recorrido local: Checkout, página de pago de prueba, suscripciones y portal.
// Al «pagar» envía a la app un webhook checkout.session.completed FIRMADO con el SDK real de Stripe
// (generateTestHeaderString + STRIPE_WEBHOOK_SECRET local), y redirige a success_url como Stripe.
// Sin red externa, sin claves reales, sin cobro. GET /__stats: sesiones, pagos y webhooks entregados.
import { createServer } from "node:http";
import { createRequire } from "node:module";
const Stripe = createRequire(import.meta.url)("stripe");
const PORT = Number(process.env.MOCK_STRIPE_PORT || 54330);
const APP = process.env.APP ?? "http://127.0.0.1:3111";
const SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_simulado_local";
const sdk = new Stripe("sk_test_simulado_sin_red");
const sessions = {}; const subs = {}; const stats = { sessions: 0, payments: 0, webhooks: [] };
let n = 0;
const form = (raw) => Object.fromEntries(new URLSearchParams(raw));
const json = (res, s, b) => { res.writeHead(s, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
createServer((req, res) => {
  let raw = ""; req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`); const p = url.pathname;
    if (p === "/__stats") return json(res, 200, stats);
    if (req.method === "POST" && p === "/v1/checkout/sessions") {
      const f = form(raw); const id = `cs_test_sim_${++n}`; stats.sessions++;
      sessions[id] = { id, user: f.client_reference_id, price: f["line_items[0][price]"], success: f.success_url, cancel: f.cancel_url, customer: f.customer || `cus_sim_${n}` };
      return json(res, 200, { id, object: "checkout.session", url: `http://127.0.0.1:${PORT}/pay/${id}` });
    }
    const pay = p.match(/^\/pay\/(cs_test_sim_\d+)$/);
    if (pay && req.method === "GET") {
      const s = sessions[pay[1]]; if (!s) return json(res, 404, {});
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!doctype html><html lang="es"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pago de prueba</title></head><body style="font-family:sans-serif;padding:16px"><main><h1>Checkout de PRUEBA (simulado)</h1><p>Precio ${s.price}. No se cobra dinero real.</p><form method="post"><button type="submit" style="font-size:18px;padding:12px 20px">Pagar (modo prueba)</button></form><p><a href="${s.cancel}">Cancelar</a></p></main></body></html>`);
    }
    if (pay && req.method === "POST") {
      const s = sessions[pay[1]]; if (!s) return json(res, 404, {});
      const subId = `sub_sim_${++n}`; stats.payments++;
      subs[subId] = { id: subId, object: "subscription", customer: s.customer, status: "active", cancel_at_period_end: false, metadata: { supabase_user_id: s.user },
        items: { object: "list", data: [{ id: `si_${n}`, current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, price: { id: s.price } }] } };
      const payload = JSON.stringify({ id: `evt_sim_${n}`, object: "event", type: "checkout.session.completed", data: { object: { id: s.id, object: "checkout.session", client_reference_id: s.user, subscription: subId, customer: s.customer } } });
      const r = await fetch(`${APP}/api/stripe/webhook`, { method: "POST", body: payload, headers: { "content-type": "application/json", "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload, secret: SECRET }) } });
      stats.webhooks.push({ type: "checkout.session.completed", status: r.status });
      res.writeHead(303, { location: s.success }); return res.end();
    }
    const sub = p.match(/^\/v1\/subscriptions\/(sub_sim_\d+)$/);
    if (sub && req.method === "GET") return subs[sub[1]] ? json(res, 200, subs[sub[1]]) : json(res, 404, { error: { type: "invalid_request_error", code: "resource_missing" } });
    if (req.method === "POST" && p === "/v1/billing_portal/sessions") return json(res, 200, { id: "bps_sim", url: `${APP}/dashboard/billing?portal=simulado` });
    json(res, 404, { error: { type: "invalid_request_error", message: `no simulado: ${req.method} ${p}` } });
  });
}).listen(PORT, "127.0.0.1", () => console.log(`mock-stripe en ${PORT}`));
