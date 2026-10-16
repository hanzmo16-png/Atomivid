/**
 * Guarda de red y de entorno del simulador (USD 0).
 *
 * - Borra del proceso TODA variable que pueda autenticar contra un proveedor
 *   real (solo se registran los NOMBRES borrados, nunca los valores).
 * - Sustituye globalThis.fetch y http(s).request: solo pasan las URLs locales
 *   (127.0.0.1/localhost, el almacenamiento simulado y Remotion) y los hosts
 *   que el simulador emula en proceso (HeyGen, D-ID, ElevenLabs, medios y
 *   Storage simulados). Cualquier otro destino se NIEGA y queda contado.
 *
 * Las claves "sim-*" que se ponen después son cadenas de relleno para que el
 * código real del adaptador recorra su camino; nunca salen del proceso porque
 * sus hosts están interceptados aquí.
 */
import http from "node:http";
import https from "node:https";

export type FakeRequest = { method: string; url: URL; headers: Headers; body: BodyInit | null | undefined };
export type FakeHandler = (req: FakeRequest) => Promise<Response>;

const PROVIDER_ENV = /^(ANTHROPIC_API_KEY|OPENAI_API_KEY|ELEVENLABS_|HEYGEN_|DID_|PEXELS_|PIXABAY_|STRIPE_|SUPABASE_|NEXT_PUBLIC_SUPABASE_|VERCEL|RUNWAY|BEATOVEN|KLING|VEO_|GOOGLE_|GEMINI|XAI_|GROK|SENTRY_|AVATAR_WEBHOOK_SECRET|LONG_FORM_REAL_RUN_CONFIRM)/;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export const guardStats = {
  scrubbedEnvNames: [] as string[],
  /** Intentos hacia destinos que NO son locales ni emulados (siempre negados). */
  blocked: [] as { method: string; host: string; path: string }[],
  /** Peticiones servidas por un proveedor emulado, por host. */
  emulated: {} as Record<string, number>,
};

const fakes = new Map<string, FakeHandler>();
let installed = false;

export function scrubProviderEnv(): string[] {
  for (const name of Object.keys(process.env)) {
    if (PROVIDER_ENV.test(name)) {
      delete process.env[name];
      guardStats.scrubbedEnvNames.push(name);
    }
  }
  if (process.env.NODE_ENV === "production") (process.env as Record<string, string>).NODE_ENV = "development";
  delete process.env.ATOMIVID_RUNTIME;
  return guardStats.scrubbedEnvNames;
}

export function registerFake(host: string, handler: FakeHandler) {
  fakes.set(host, handler);
}

export function unregisterFake(host: string) {
  fakes.delete(host);
}

function deny(method: string, url: URL): never {
  guardStats.blocked.push({ method, host: url.host, path: url.pathname });
  throw new Error(`[simulador] llamada externa NEGADA: ${method} ${url.host}${url.pathname}`);
}

export function installNetworkGuard() {
  if (installed) return;
  installed = true;
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (LOCAL_HOSTS.has(url.hostname)) return realFetch(input, init);
    const fake = fakes.get(url.hostname);
    if (!fake) deny(method, url);
    guardStats.emulated[url.hostname] = (guardStats.emulated[url.hostname] ?? 0) + 1;
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return fake({ method, url, headers: new Headers(init?.headers), body: init?.body });
  }) as typeof fetch;

  for (const mod of [http, https] as const) {
    const original = mod.request.bind(mod) as (...args: unknown[]) => http.ClientRequest;
    const wrapped = (...args: unknown[]) => {
      const first = args[0];
      const host = typeof first === "string" ? new URL(first).hostname
        : first instanceof URL ? first.hostname
        : String((first as { hostname?: string; host?: string })?.hostname ?? (first as { host?: string })?.host ?? "localhost").split(":")[0];
      if (!LOCAL_HOSTS.has(host)) deny("REQUEST", new URL(`https://${host}/`));
      return original(...args);
    };
    (mod as { request: unknown }).request = wrapped;
    (mod as { get: unknown }).get = (...args: unknown[]) => {
      const req = wrapped(...args);
      req.end();
      return req;
    };
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
