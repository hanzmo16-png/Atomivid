// Solo para el control negativo «red» del preflight: se carga en el worker DESPUÉS de net-guard.mjs e intenta salir a
// internet por fetch y por socket. El cortafuegos debe bloquear y anotar ambos intentos, de modo que N1 falle. Si N1
// pasara con este archivo cargado, el cortafuegos no estaría activo en el proceso real del worker.
import net from "node:net";
try { await fetch("https://example.com/preflight-canary"); } catch { /* bloqueado: esperado */ }
await new Promise((ok) => { const s = net.connect(443, "1.1.1.1"); s.on("error", ok); s.on("connect", () => { s.destroy(); ok(); }); });
