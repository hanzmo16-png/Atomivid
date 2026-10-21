// Precarga SOLO para el proceso local de Next (arnés E2E): el despacho a GitHub se entrega al worker de prueba local;
// cualquier otra salida a la red que no sea loopback se rechaza y se registra (USD 0, sin proveedores).
const fs = require("fs"); const LOG = process.env.E2E_EGRESS_LOG;
const orig = globalThis.fetch;
const os = require("os"); const oni = os.networkInterfaces;
os.networkInterfaces = function () { try { return oni.call(os); } catch { return { lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }] }; } };
globalThis.fetch = async function (input, init = {}) {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
  if (/^https:\/\/api\.github\.com\/repos\/local\/test\/dispatches$/.test(url)) {
    LOG && fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), kind: "dispatch", body: JSON.parse(String(init.body)) }) + "\n");
    const r = await orig(process.env.E2E_DISPATCH_URL || "http://127.0.0.1:54400/dispatch", { method: "POST", body: init.body, headers: { "content-type": "application/json" } });
    return new Response(null, { status: r.ok ? 204 : 502 });
  }
  // Podcast 2.1: TODO api.elevenlabs.io → mock local con espeak-ng (voces, saldo y TTS simulados; USD 0).
  const EL = process.env.MOCK_EL_URL;
  if (EL && /^https:\/\/api\.elevenlabs\.io\//.test(url)) return orig(url.replace(/^https:\/\/api\.elevenlabs\.io\//, `${EL}/`), init);
  // Podcast 2.1 video: Pexels (búsqueda y descarga de medios) → mock local con medios generados (USD 0).
  const PX = process.env.MOCK_PEXELS_URL;
  if (PX && /^https:\/\/api\.pexels\.com\//.test(url)) return orig(url.replace(/^https:\/\/api\.pexels\.com\//, `${PX}/`), init);
  if (PX && /^https:\/\/(videos|images)\.pexels\.com\//.test(url)) return orig(url.replace(/^https:\/\/(videos|images)\.pexels\.com\//, `${PX}/`), init);
  // Ensayo Long Form: catálogo de voces y saldo fal → mock local (solo metadatos; nunca síntesis ni gasto).
  const M = process.env.MOCK_LF_URL;
  if (M && /^https:\/\/api\.elevenlabs\.io\/v1\/voices/.test(url)) return orig(url.replace(/^https:\/\/api\.elevenlabs\.io\//, `${M}/el/`), init);
  if (M && /^https:\/\/api\.fal\.ai\//.test(url)) return orig(url.replace(/^https:\/\/api\.fal\.ai\//, `${M}/falapi/`), init);
  if (!["127.0.0.1", "localhost", "::1", ""].includes(host) && !url.startsWith("data:")) {
    LOG && fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), kind: "egress_refused", host }) + "\n");
    throw new Error(`E2E: salida no loopback rechazada (${host})`);
  }
  return orig(input, init);
};
