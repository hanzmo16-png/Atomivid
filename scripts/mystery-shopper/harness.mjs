/**
 * Arnés local del modo gratuito. No es ATOMIVID en producción.
 * Cada pantalla dice FIXTURE. No llama a proveedores ni a Supabase.
 * Uso: node scripts/mystery-shopper/harness.mjs
 * Variables: MS_AUDIO, MS_VIDEO, MS_REEL, MS_LONG (rutas de archivos ya generados).
 */
import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const files = {
  audio: process.env.MS_AUDIO || "",
  video: process.env.MS_VIDEO || "",
  reel: process.env.MS_REEL || "",
  long: process.env.MS_LONG || "",
};
const projects = new Map();

const page = (title, body) => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.45 system-ui, sans-serif; background: #f6f4ef; color: #1c1915; }
  header, main { width: min(100%, 720px); margin: 0 auto; padding: 16px; }
  .banner { background: #3f2e12; color: #fff8e8; padding: 10px 16px; font-size: 14px; }
  a, button, input, select, textarea { font: inherit; }
  a { color: #6b3f12; }
  nav { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 8px; }
  nav a, main a, button, .hit { min-height: 44px; display: inline-flex; align-items: center; padding: 8px 12px; border-radius: 8px; border: 1px solid #c8b79a; background: #fff; color: #1c1915; text-decoration: none; }
  button[disabled] { opacity: 0.55; }
  label { display: block; margin: 12px 0 4px; font-weight: 600; }
  input, select, textarea { width: 100%; max-width: 100%; min-height: 44px; padding: 10px; border-radius: 8px; border: 1px solid #c8b79a; background: #fff; }
  textarea { min-height: 120px; }
  .card { background: #fff; border: 1px solid #e4d8c4; border-radius: 12px; padding: 16px; margin-top: 12px; }
  .ok { background: #e7f6ec; }
  .warn { background: #fff4d6; }
  [role="alert"] { background: #fde8e4; padding: 10px; border-radius: 8px; }
  audio, video { width: 100%; margin-top: 8px; }
</style>
</head>
<body>
<p class="banner">FIXTURE · no es ATOMIVID en producción · USD 0.00 · no se llama a ningún proveedor</p>
<header><nav aria-label="Menú principal">
  <a href="/dashboard">Inicio</a>
  <a href="/dashboard/audio-studio">Audio Podcast</a>
  <a href="/dashboard/podcast">Video Podcast</a>
  <a href="/dashboard/new">Reel</a>
  <a href="/dashboard/long-form/new">Long Form</a>
  <a href="/dashboard/youtube">YouTube</a>
  <a href="/dashboard/biblioteca">Biblioteca</a>
  <a href="/dashboard/billing">Facturación</a>
  <a href="/dashboard/command-center">Command Center</a>
</nav></header>
<main><h1>${title}</h1>${body}</main>
</body></html>`;

function authed(req) {
  return /(?:^|;\s*)ms=1(?:;|$)/.test(req.headers.cookie || "");
}

function send(res, status, html, extra = {}) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra });
  res.end(html);
}

function needAuth(req, res) {
  if (authed(req)) return false;
  send(res, 401, page("Inicia sesión", `<p role="alert">Para ver los productos hay que iniciar sesión con la cuenta fixture.</p><p><a href="/login">Ir a iniciar sesión</a></p>`));
  return true;
}

const loginForm = (error) => page("Iniciar sesión", `
  <p>Cuenta de prueba del arnés, marcada como fixture. No sirve en ATOMIVID real.</p>
  ${error ? `<p role="alert">${error}</p>` : ""}
  <form method="post" action="/login" class="card">
    <label for="email">Correo electrónico</label>
    <input id="email" name="email" type="email" autocomplete="username" required/>
    <label for="password">Contraseña</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required/>
    <button type="submit" class="hit" style="margin-top:12px">Iniciar sesión</button>
  </form>`);

async function file(res, filePath, name) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("no");
    res.writeHead(200, {
      "content-type": name.endsWith(".mp3") ? "audio/mpeg" : "video/mp4",
      "content-length": String(info.size),
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
      "x-fixture": "1",
    });
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Archivo fixture no disponible");
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.method === "GET" && url.pathname === "/login") return send(res, 200, loginForm(""));
  if (req.method === "POST" && url.pathname === "/login") {
    const form = new URLSearchParams(await readBody(req));
    if (form.get("email") === "qa-fixture@atomivid.test" && form.get("password") === "fixture-local-only") {
      res.writeHead(303, { location: "/dashboard", "set-cookie": "ms=1; HttpOnly; Path=/; SameSite=Lax" });
      res.end();
      return;
    }
    return send(res, 401, loginForm("Correo o contraseña incorrectos. No se creó ninguna sesión."));
  }
  if (req.method === "GET" && url.pathname === "/archivo/flannan-fixture.mp3") return file(res, files.audio, "flannan-fixture.mp3");
  if (req.method === "GET" && url.pathname === "/archivo/oceano-fixture.mp4") return file(res, files.video, "oceano-fixture.mp4");
  if (req.method === "GET" && url.pathname === "/archivo/reel-fixture.mp4") return file(res, files.reel, "reel-universo-fixture.mp4");
  if (req.method === "GET" && url.pathname === "/archivo/nazca-fixture.mp4") return file(res, files.long, "nazca-fixture.mp4");
  if (needAuth(req, res)) return;

  if (req.method === "GET" && url.pathname === "/dashboard") {
    return send(res, 200, page("¿Qué quieres crear hoy?", `<p>Elige un producto en el menú principal. Todo lo que hay aquí es FIXTURE.</p>`));
  }
  if (req.method === "POST" && url.pathname === "/dashboard/audio-studio") {
    const form = new URLSearchParams(await readBody(req));
    const token = form.get("token") || "";
    if (!token || token.length > 80) return send(res, 400, page("Audio Podcast", `<p role="alert">No se pudo crear el episodio.</p>`));
    const existed = projects.has(token);
    if (!existed) projects.set(token, { id: "ep-fixture", title: form.get("title") || "Episodio FIXTURE", script: form.get("script") || "" });
    return send(res, 200, page("Audio Podcast", editor(projects.get(token), existed)));
  }
  if (req.method === "GET" && url.pathname === "/dashboard/audio-studio") {
    return send(res, 200, page("Audio Podcast Studio", `
      <p>Podcast solo audio. Una o dos voces, música ambiental y presupuesto visible. Nada se cobra en este fixture.</p>
      <form method="post" action="/dashboard/audio-studio" class="card" id="audio-new">
        <h2>Nuevo episodio</h2>
        <input type="hidden" name="token" value="audio-fixture-1"/>
        <label for="title">Título</label>
        <input id="title" name="title" required maxlength="120" placeholder="¿De qué trata el episodio?"/>
        <label for="script">Instrucciones</label>
        <textarea id="script" name="script" required>Islas Flannan, en español, 10 minutos, 2 voces y música ambiental.</textarea>
        <label for="language">Idioma</label>
        <select id="language" name="language"><option value="es">Español</option><option value="en">Inglés</option></select>
        <fieldset><legend>Voces</legend>
          <label><input type="radio" name="voices" value="1"/> Una voz</label>
          <label><input type="radio" name="voices" value="2" checked/> Dos voces</label>
        </fieldset>
        <label><input type="checkbox" name="music" value="1" checked/> Música ambiental</label>
        <p class="card ok" id="budget">Presupuesto máximo: USD 0.00. No se cobra. FIXTURE.</p>
        <button type="submit">Crear episodio</button>
      </form>`));
  }
  if (req.method === "GET" && url.pathname === "/dashboard/podcast") return send(res, 200, mediaPage("Video Podcast Studio", "Océano profundo, en español, 5 minutos, 2 presentadores, estilo documental.", "/archivo/oceano-fixture.mp4", "video/mp4", "oceano-fixture.mp4"));
  if (req.method === "GET" && url.pathname === "/dashboard/new") return send(res, 200, mediaPage("Reels Studio", "Tres misterios del universo, en inglés, 30 segundos, vertical 9:16.", "/archivo/reel-fixture.mp4", "video/mp4", "reel-universo-fixture.mp4"));
  if (req.method === "GET" && url.pathname === "/dashboard/long-form/new") return send(res, 200, mediaPage("Long Form Studio", "Líneas de Nazca, en español, 15 minutos, horizontal 16:9, con capítulos y metadatos.", "/archivo/nazca-fixture.mp4", "video/mp4", "nazca-fixture.mp4"));
  if (req.method === "GET" && url.pathname === "/dashboard/youtube") {
    return send(res, 200, page("YouTube Studio", `
      <p>Usa un video ATOMIVID ya autorizado. Esta evaluación no publica ni programa.</p>
      <form class="card">
        <label for="video">Video</label>
        <select id="video"><option>Video autorizado FIXTURE</option></select>
        <label for="yt-title">Título</label>
        <input id="yt-title" value="Líneas de Nazca · borrador FIXTURE"/>
        <label for="yt-desc">Descripción</label>
        <textarea id="yt-desc">Borrador de prueba. No publicar.</textarea>
        <label for="yt-tags">Etiquetas</label>
        <input id="yt-tags" value="nazca, historia, fixture"/>
        <p>Miniatura: vista previa del fotograma fixture. No se sube nada.</p>
        <label for="privacy">Privacidad</label>
        <select id="privacy"><option>Privado</option></select>
        <p class="card ok" id="preview">Vista previa del borrador. Sigue en privado.</p>
        <p class="card warn">Prohibido publicar o programar en esta evaluación.</p>
        <button type="button" disabled>Publicar</button>
        <button type="button" disabled>Programar</button>
      </form>`));
  }
  if (req.method === "GET" && url.pathname === "/dashboard/biblioteca") {
    const items = [...projects.values()];
    const list = [`<li><a href="/dashboard/audio-studio">Islas Flannan FIXTURE</a> · <a href="/archivo/flannan-fixture.mp3">Descargar MP3</a></li>`, ...items.map((p) => `<li>${p.title} FIXTURE</li>`)].join("");
    return send(res, 200, page("Biblioteca", `<p>Proyectos de esta sesión fixture. No se borró nada de una biblioteca real.</p><ul>${list}</ul><p class="card ok" role="status">El episodio de prueba sigue aquí después de salir y volver.</p>`));
  }
  if (req.method === "GET" && url.pathname === "/dashboard/billing") {
    return send(res, 200, page("Facturación", `<p class="card ok">Presupuesto de esta evaluación: USD 0.00. No hay un cobro en curso.</p><p>La cuenta fixture no tiene suscripción real.</p>`));
  }
  if (req.method === "GET" && url.pathname === "/dashboard/command-center") {
    return send(res, 200, page("Command Center", `<p>FIXTURE. El Command Center de ATOMIVID solo lo abre el dueño. Esta pantalla no muestra saldos, proyectos ni el ledger reales.</p><p><a href="/dashboard/command-center#mystery-shopper">Mystery Shopper AI</a> vive en el Command Center real, no en este arnés.</p>`));
  }
  send(res, 404, page("No disponible", `<p role="alert">Esta pantalla no está en el arnés fixture.</p>`));
});

function editor(project, duplicate) {
  return `<p role="status" id="progress">Archivo de prueba listo. FIXTURE. USD 0.00.</p>
    ${duplicate ? `<p role="status">Ya estaba creado. No se duplicó.</p>` : ""}
    <div class="card">
      <p>Episodio guardado: ${escapeHtml(project.title)}. FIXTURE.</p>
      <p>Instrucciones: ${escapeHtml(project.script)}</p>
      <p id="budget">Presupuesto máximo: USD 0.00. No se cobra.</p>
      <p>Voces: dos. Música ambiental: incluida en el archivo de prueba. El MP3 ya está listo.</p>
      <p>El botón de generación real está apagado. El archivo de prueba se puede oír y descargar.</p>
      <button type="button" disabled>Generar con proveedor</button>
      <audio controls src="/archivo/flannan-fixture.mp3"></audio>
      <p><a href="/archivo/flannan-fixture.mp3">Descargar MP3</a></p>
      <p><a href="/dashboard/biblioteca">Ver en la biblioteca</a></p>
      <form method="post" action="/dashboard/audio-studio">
        <input type="hidden" name="token" value="audio-fixture-1"/>
        <input type="hidden" name="title" value="${escapeHtml(project.title)}"/>
        <input type="hidden" name="script" value="${escapeHtml(project.script)}"/>
        <button type="submit">Crear el mismo episodio otra vez</button>
      </form>
    </div>`;
}

function mediaPage(title, instructions, src, type, filename) {
  const tag = type.startsWith("video") ? `<video controls src="${src}"></video>` : `<audio controls src="${src}"></audio>`;
  return page(title, `
    <p>${escapeHtml(instructions)}</p>
    <p class="card ok" id="budget" role="status">Presupuesto máximo: USD 0.00. Archivo de prueba listo. FIXTURE.</p>
    <p>Generar con un proveedor está apagado. Este archivo no afirma cumplir la duración de la misión.</p>
    <button type="button" disabled>Generar con proveedor</button>
    ${tag}
    <p><a href="${src}">Descargar ${escapeHtml(filename)}</a></p>
    <p><a href="/dashboard/biblioteca">Ver en la biblioteca</a></p>`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`READY ${address.port}\n`);
});
