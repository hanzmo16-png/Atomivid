/**
 * Precarga del simulador para los renders de Remotion (Reel y Long Form).
 *
 * Envuelve @remotion/renderer.renderMedia SIN tocar el motor de ATOMIVID:
 *  1. Captura las props reales que el pipeline manda a render (escenas,
 *     subtítulos, huecos de narración, duración) y copia la narración y la
 *     música servidas por el almacenamiento local, para auditarlas después.
 *  2. Con SIM_RENDER_PROFILE=structural_lowres aplica el perfil acelerado de
 *     simulación: scale=0.25 (1920x1080 → 480x270, 1080x1920 → 270x480),
 *     x264 "ultrafast", CRF 35. Duración, fps, escenas, cortes, pistas de audio
 *     y tiempos NO cambian: la composición y sus props son las mismas.
 *  3. Con SIM_CAPTION_STILLS=1 renderiza, tras el MP4, fotogramas de control
 *     del MISMO frame con y sin subtítulos para comprobar que los subtítulos
 *     aparecen de verdad en el MP4.
 *
 * Uso: node --require ./scripts/simulator/render-capture.cjs --import tsx <script>
 * (o require() desde el propio simulador). Inactivo sin SIM_CAPTURE_DIR.
 */
const fs = require("node:fs");
const path = require("node:path");

const captureDir = process.env.SIM_CAPTURE_DIR;

// Guarda de red para procesos hijos (p. ej. produce-long-form-video.ts): solo destinos locales.
if (process.env.SIM_NETWORK_GUARD === "1") {
  const http = require("node:http");
  const https = require("node:https");
  const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  const blockedLog = path.join(captureDir || require("node:os").tmpdir(), `blocked-${process.pid}.jsonl`);
  const deny = (method, host, p) => {
    fs.appendFileSync(blockedLog, JSON.stringify({ method, host, path: p }) + "\n");
    throw new Error(`[simulador] llamada externa NEGADA: ${method} ${host}${p}`);
  };
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!LOCAL.has(url.hostname)) deny((init && init.method) || "GET", url.host, url.pathname);
    return realFetch(input, init);
  };
  for (const mod of [http, https]) {
    const original = mod.request.bind(mod);
    const wrapped = (...args) => {
      const a = args[0];
      const host = typeof a === "string" ? new URL(a).hostname : a instanceof URL ? a.hostname : String((a && (a.hostname || a.host)) || "localhost").split(":")[0];
      if (!LOCAL.has(host)) deny("REQUEST", host, "/");
      return original(...args);
    };
    mod.request = wrapped;
    mod.get = (...args) => { const r = wrapped(...args); r.end(); return r; };
  }
}

if (captureDir) {
  const renderer = require("@remotion/renderer");
  const original = renderer.renderMedia;
  let counter = 0;
  const wrapped = async function simulatedRenderMedia(opts) {
    const index = ++counter;
    const profile = process.env.SIM_RENDER_PROFILE || "production";
    const effective = { ...opts };
    if (profile === "structural_lowres") {
      effective.scale = 0.25;
      effective.x264Preset = "ultrafast";
      effective.crf = 35;
      delete effective.encodingMaxRate;
      delete effective.encodingBufferSize;
    }
    const dir = path.join(captureDir, `render-${process.pid}-${index}`);
    fs.mkdirSync(dir, { recursive: true });
    const props = opts.inputProps || {};
    const copy = async (url, name) => {
      if (!url) return null;
      const res = await fetch(url);
      if (!res.ok) return null;
      const file = path.join(dir, name);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return file;
    };
    const narrationFile = await copy(props.audioUrl, "narration" + path.extname(new URL(props.audioUrl).pathname));
    const musicFile = props.musicUrl ? await copy(props.musicUrl, "music" + path.extname(new URL(props.musicUrl).pathname)) : null;
    const startedAt = Date.now();
    const result = await original(effective);
    const renderMs = Date.now() - startedAt;
    const comp = opts.composition;
    const record = {
      index,
      profile,
      compositionId: comp.id,
      compositionWidth: comp.width,
      compositionHeight: comp.height,
      fps: comp.fps,
      durationInFrames: comp.durationInFrames,
      scale: effective.scale ?? 1,
      x264Preset: effective.x264Preset ?? null,
      crf: effective.crf ?? null,
      renderMs,
      outputLocation: opts.outputLocation,
      narrationFile,
      musicFile,
      durationSeconds: props.durationSeconds,
      scenes: (props.scenes || []).map((s) => ({ id: s.id, startSeconds: s.startSeconds, endSeconds: s.endSeconds, kind: s.asset ? s.asset.kind : s.type || null })),
      captions: props.captions || [],
      narrationGaps: props.narrationGaps || [],
      stills: [],
    };
    if (process.env.SIM_CAPTION_STILLS === "1" && record.captions.length > 0) {
      const picks = [0, Math.floor(record.captions.length / 2), record.captions.length - 1];
      for (const i of [...new Set(picks)]) {
        const c = record.captions[i];
        const frame = Math.round(((c.startSeconds + c.endSeconds) / 2) * comp.fps);
        const base = { composition: comp, serveUrl: opts.serveUrl, frame, scale: effective.scale ?? 1, imageFormat: "png", browserExecutable: opts.browserExecutable, chromeMode: opts.chromeMode };
        const withFile = path.join(dir, `still-${frame}-with.png`);
        const withoutFile = path.join(dir, `still-${frame}-without.png`);
        // Remotion v4 renderiza con composition.props: la variante sin subtítulos se pasa ahí también.
        const noCaptions = { ...props, captions: [] };
        await renderer.renderStill({ ...base, inputProps: props, output: withFile });
        await renderer.renderStill({ ...base, composition: { ...comp, props: { ...(comp.props || props), captions: [] } }, inputProps: noCaptions, output: withoutFile });
        record.stills.push({ captionIndex: i, text: c.text, frame, withCaptions: withFile, withoutCaptions: withoutFile });
      }
    }
    fs.writeFileSync(path.join(dir, "capture.json"), JSON.stringify(record, null, 2));
    return result;
  };
  Object.defineProperty(renderer, "renderMedia", { value: wrapped, configurable: true, writable: true, enumerable: true });
}
