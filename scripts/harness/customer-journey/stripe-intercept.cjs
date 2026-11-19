// Precarga SOLO para el proceso local de Next del recorrido «paid» (NODE_OPTIONS=--require …): las llamadas del SDK de
// Stripe a api.stripe.com se entregan al Stripe SIMULADO local (mock-stripe.mjs). Nada sale a internet, no hay claves
// reales y no se cobra nada. No forma parte de la app: no se importa desde src/.
const http = require("http"); const https = require("https");
const PORT = Number(process.env.MOCK_STRIPE_PORT || 54330);
const orig = https.request;
https.request = function (opts, cb) {
  const host = typeof opts === "object" && opts ? (opts.hostname || opts.host) : null;
  if (host !== "api.stripe.com") return orig.apply(this, arguments);
  const req = http.request({ ...opts, host: "127.0.0.1", hostname: "127.0.0.1", port: PORT, agent: undefined, ciphers: undefined }, cb);
  // El SDK espera 'secureConnect' (TLS) antes de escribir el cuerpo; en HTTP local el evento es 'connect'.
  req.once("socket", (s) => { if (s.connecting) s.once("connect", () => s.emit("secureConnect")); });
  return req;
};
