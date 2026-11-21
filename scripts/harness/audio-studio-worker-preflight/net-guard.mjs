// Cortafuegos de proceso: se carga con NODE_OPTIONS="--import <este archivo>" en el worker. Solo permite 127.0.0.1 /
// localhost / ::1; cualquier otra conexión (fetch o socket) se rechaza y queda anotada en PREFLIGHT_NET_LOG.
import net from "node:net";
import { appendFileSync } from "node:fs";

const LOG = process.env.PREFLIGHT_NET_LOG;
const local = (h) => h === undefined || h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
const note = (what) => { if (LOG) appendFileSync(LOG, JSON.stringify({ pid: process.pid, what }) + "\n"); };

const origFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!local(u.hostname)) { note(`fetch ${u.host}`); throw new Error(`preflight: red externa bloqueada (${u.host})`); }
  return origFetch(input, init);
};
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect() llega aquí con los argumentos ya normalizados como arreglo [opciones, callback].
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const o = typeof first === "object" && first !== null ? first : { port: first, host: typeof args[1] === "string" ? args[1] : undefined };
  if (!o.path && !local(o.host)) { note(`socket ${o.host}:${o.port}`); this.destroy(new Error(`preflight: red externa bloqueada (${o.host})`)); return this; }
  return origConnect.apply(this, args);
};
