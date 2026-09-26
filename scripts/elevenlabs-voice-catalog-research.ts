/**
 * Investigación de SOLO LECTURA para elegir las cuatro voces nuevas del
 * catálogo (dos masculinas y dos femeninas, además de Mateo).
 *
 * Solo hace GET contra ElevenLabs y descarga las previews PÚBLICAS de la
 * biblioteca (preview_url). No sintetiza audio, no consume créditos, no
 * agrega ni elimina voces y no toca la configuración de producción.
 *
 * Qué registra (evidence/voices/):
 *  - schema.json: claves reales de la respuesta de /v1/shared-voices y de
 *    una voz (para no asumir el esquema documentado).
 *  - account.json: plan, cuota de caracteres, límites de voces y de
 *    clonación (solo esos campos; nunca facturación ni la clave).
 *  - my-voices.json: My Voices (id, nombre, categoría) — distinto de la
 *    biblioteca compartida.
 *  - models.json: modelos con español/inglés.
 *  - queries.json: cada consulta a la biblioteca (filtros, orden, estado
 *    HTTP, cantidad) — un orden rechazado queda registrado, no se inventa.
 *  - candidates.json: voces vistas con sus métricas (uso anual, uso 7 días,
 *    clonaciones, posición en cada orden), tarifas, idiomas verificados y
 *    el puntaje por perfil (heurístico, sobre la descripción: NO es una
 *    medición de calidad).
 *  - previews/*.mp3 + acoustic.json: previews de las preseleccionadas y
 *    métricas objetivas (duración, sonoridad, tono fundamental mediano).
 *    Las métricas no sustituyen escuchar: la naturalidad la juzga una
 *    persona.
 *
 * Uso: ELEVENLABS_API_KEY=... npx tsx scripts/elevenlabs-voice-catalog-research.ts
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const API = "https://api.elevenlabs.io";
const OUT = process.env.VOICE_RESEARCH_OUT || "evidence/voices";
const MATEO_ID = "uYlzyj2kIZo3HfBB21vF";
const SORTS = ["usage_character_count_1y", "trending", "cloned_by_count"] as const;
const GENDERS = ["male", "female"] as const;

type Json = Record<string, unknown>;
type Profile = "male_cinematic" | "male_conversational" | "female_warm" | "female_firm";

const PROFILES: Record<Profile, { gender: "male" | "female"; label: string; want: string[]; avoid: string[] }> = {
  male_cinematic: {
    gender: "male",
    label: "Masculina 1: grave, cinematográfica (historia, misterio, Medieval oscuro)",
    want: ["deep", "grave", "cinematic", "epic", "dramatic", "narrat", "storytell", "documentary", "mysterious", "dark", "baritone", "bass", "intense", "profund", "cinematográf", "épic"],
    avoid: ["child", "kid", "cartoon", "comedic", "funny", "anime", "asmr", "whisper", "old", "elderly"],
  },
  male_conversational: {
    gender: "male",
    label: "Masculina 2: natural, clara, conversacional (distinta de Mateo)",
    want: ["conversational", "natural", "casual", "clear", "friendly", "social", "young", "relaxed", "informative", "educational", "conversacional", "cercan", "clar"],
    avoid: ["child", "kid", "cartoon", "anime", "asmr", "whisper", "old", "elderly", "announcer"],
  },
  female_warm: {
    gender: "female",
    label: "Femenina 1: cálida y cercana (podcast)",
    want: ["warm", "soft", "friendly", "podcast", "conversational", "gentle", "calm", "natural", "cálid", "cercan", "suave", "amable"],
    avoid: ["child", "kid", "cartoon", "anime", "asmr", "whisper", "old", "elderly", "sensual", "seductive"],
  },
  female_firm: {
    gender: "female",
    label: "Femenina 2: firme y narrativa",
    want: ["narrat", "confident", "strong", "firm", "professional", "authoritative", "clear", "storytell", "documentary", "news", "mature", "firme", "segur", "profesional"],
    avoid: ["child", "kid", "cartoon", "anime", "asmr", "whisper", "old", "elderly", "sensual", "seductive"],
  },
};

const LATAM = ["latin", "latam", "latino", "mexic", "colombi", "argentin", "chile", "peru", "venezuel", "es-419", "es-mx", "es-co", "es-ar", "es-cl", "es-pe", "es-us"];
const SPAIN = ["castilian", "spain", "peninsular", "es-es", "european"];

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function get(pathname: string, apiKey: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API}${pathname}`, { headers: { "xi-api-key": apiKey } });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // cuerpo no JSON: se conserva como texto (nunca contiene la clave)
  }
  return { status: res.status, body };
}

async function writeJson(name: string, data: unknown) {
  await fs.writeFile(path.join(OUT, name), JSON.stringify(data, null, 2));
}

function haystack(v: Json): string {
  const useCases = Array.isArray(v.use_cases) ? (v.use_cases as unknown[]).map(String).join(" ") : "";
  const descriptives = Array.isArray(v.descriptives) ? (v.descriptives as unknown[]).map(String).join(" ") : "";
  return [v.name, v.accent, v.locale, v.age, v.descriptive, v.description, v.use_case, useCases, descriptives, v.category]
    .map((x) => (typeof x === "string" ? x : ""))
    .join(" ")
    .toLowerCase();
}

function verifiedLanguages(v: Json): { language: string; locale: string; accent: string; model: string; preview: string }[] {
  if (!Array.isArray(v.verified_languages)) return [];
  return (v.verified_languages as Json[]).map((l) => ({
    language: str(l.language),
    locale: str(l.locale),
    accent: str(l.accent),
    model: str(l.model_id),
    preview: str(l.preview_url),
  }));
}

/**
 * Recargos reales: tarifa distinta de la normal (rate/credit_multiplier > 1 o
 * fiat_rate). notice_period NO es un recargo: son los días que el dueño debe
 * avisar antes de retirar la voz (garantía de disponibilidad para quien ya la
 * agregó); live_moderation_enabled y free_users_allowed=false son condiciones
 * a declarar, no costos.
 */
function surcharges(v: Json): string[] {
  const out: string[] = [];
  for (const k of ["rate", "credit_multiplier"]) {
    const n = num(v[k]);
    if (n !== null && n > 1) out.push(`${k}=${n}`);
  }
  if (v.fiat_rate !== undefined && v.fiat_rate !== null) out.push(`fiat_rate=${JSON.stringify(v.fiat_rate)}`);
  return out;
}

function conditions(v: Json): string[] {
  const out: string[] = [];
  const notice = num(v.notice_period);
  if (notice !== null && notice > 0) out.push(`aviso de retiro ${notice} días (garantía)`);
  if (v.live_moderation_enabled === true) out.push("moderación en vivo del dueño");
  if (v.free_users_allowed === false) out.push("requiere plan de pago");
  return out;
}

function profileScore(v: Json, profile: Profile): { score: number; reasons: string[] } {
  const p = PROFILES[profile];
  const text = haystack(v);
  if (str(v.gender).toLowerCase() !== p.gender) return { score: -1, reasons: ["género distinto"] };
  const reasons: string[] = [];
  let score = 0;
  const hits = p.want.filter((w) => text.includes(w));
  score += hits.length * 3;
  if (hits.length) reasons.push(`descripción: ${hits.join(", ")}`);
  const bad = p.avoid.filter((w) => text.includes(w));
  score -= bad.length * 6;
  if (bad.length) reasons.push(`penaliza: ${bad.join(", ")}`);
  const langs = verifiedLanguages(v);
  const accentText = `${text} ${langs.map((l) => `${l.locale} ${l.accent}`).join(" ").toLowerCase()}`;
  if (LATAM.some((s) => accentText.includes(s))) {
    score += 6;
    reasons.push("acento latinoamericano/neutro declarado");
  } else if (SPAIN.some((s) => accentText.includes(s))) {
    score -= 4;
    reasons.push("acento de España (no priorizado)");
  }
  const s = surcharges(v);
  if (s.length) {
    score -= 20;
    reasons.push(`condiciones especiales: ${s.join("; ")}`);
  }
  return { score, reasons };
}

async function acoustic(file: string): Promise<Json> {
  const probe = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file]);
  const duration = Number((JSON.parse(probe.stdout) as { format: { duration: string } }).format.duration);
  const loud = await run("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128", "-f", "null", "-"]).catch((e) => e as { stderr: string });
  const integrated = /I:\s+(-?\d+(?:\.\d+)?) LUFS/.exec(String((loud as { stderr: string }).stderr).split("Summary:").pop() ?? "")?.[1];
  // Tono fundamental mediano (autocorrelación en ventanas sonoras de 40 ms, 16 kHz mono): orientativo.
  const pcm = await run("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  const buf = pcm.stdout as unknown as Buffer;
  const samples = new Float32Array(buf.length / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(i * 2) / 32768;
  const win = 640;
  const f0s: number[] = [];
  for (let start = 0; start + win < samples.length; start += win) {
    let energy = 0;
    for (let i = 0; i < win; i++) energy += samples[start + i] ** 2;
    if (Math.sqrt(energy / win) < 0.02) continue;
    let bestLag = 0;
    let best = 0;
    for (let lag = 32; lag <= 267; lag++) {
      let c = 0;
      for (let i = 0; i < win - lag; i++) c += samples[start + i] * samples[start + i + lag];
      if (c > best) {
        best = c;
        bestLag = lag;
      }
    }
    if (bestLag > 0 && best / energy > 0.3) f0s.push(16000 / bestLag);
  }
  f0s.sort((a, b) => a - b);
  const median = f0s.length ? Math.round(f0s[Math.floor(f0s.length / 2)]) : null;
  return { durationSeconds: Math.round(duration * 10) / 10, integratedLufs: integrated ? Number(integrated) : null, medianF0Hz: median, voicedFrames: f0s.length };
}

async function main() {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("ELEVENLABS_API_KEY no está definido");
  await fs.mkdir(path.join(OUT, "previews"), { recursive: true });

  // 1. Esquema vigente (no se asume el documentado).
  const probe = await get("/v1/shared-voices?page_size=1&language=es", apiKey);
  const probeBody = probe.body as Json;
  const first = Array.isArray(probeBody?.voices) ? ((probeBody.voices as Json[])[0] ?? {}) : {};
  await writeJson("schema.json", { status: probe.status, responseKeys: Object.keys(probeBody ?? {}), voiceKeys: Object.keys(first).sort() });
  console.log(`[schema] /v1/shared-voices ${probe.status}; campos de voz: ${Object.keys(first).sort().join(", ")}`);

  // 2. Cuenta: solo plan, cuotas y límites de voces/clonación.
  const sub = await get("/v1/user/subscription", apiKey);
  const s = (sub.body ?? {}) as Json;
  const account = {
    status: sub.status,
    tier: s.tier,
    character_count: s.character_count,
    character_limit: s.character_limit,
    next_character_count_reset_unix: s.next_character_count_reset_unix,
    voice_limit: s.voice_limit,
    voice_slots_used: s.voice_slots_used,
    voice_add_edit_counter: s.voice_add_edit_counter,
    professional_voice_limit: s.professional_voice_limit,
    professional_voice_slots_used: s.professional_voice_slots_used,
    can_use_instant_voice_cloning: s.can_use_instant_voice_cloning,
    can_use_professional_voice_cloning: s.can_use_professional_voice_cloning,
    subscription_status: s.status,
  };
  await writeJson("account.json", account);
  console.log(`[cuenta] ${JSON.stringify(account)}`);

  // 3. My Voices (distinto de la biblioteca compartida).
  const mine = await get("/v1/voices", apiKey);
  const myVoices = Array.isArray((mine.body as Json)?.voices)
    ? ((mine.body as Json).voices as Json[]).map((v) => ({ voice_id: v.voice_id, name: v.name, category: v.category, sharing_status: (v.sharing as Json | undefined)?.status }))
    : [];
  await writeJson("my-voices.json", { status: mine.status, count: myVoices.length, voices: myVoices });
  console.log(`[my-voices] ${mine.status}: ${myVoices.length} voces; Mateo presente: ${myVoices.some((v) => v.voice_id === MATEO_ID)}`);

  // 4. Modelos con español e inglés.
  const models = await get("/v1/models", apiKey);
  const modelRows = Array.isArray(models.body)
    ? (models.body as Json[]).map((m) => ({
        model_id: m.model_id,
        can_do_text_to_speech: m.can_do_text_to_speech,
        languages: Array.isArray(m.languages) ? (m.languages as Json[]).map((l) => l.language_id).filter((id) => id === "es" || id === "en") : [],
        max_characters_request_subscribed_user: m.max_characters_request_subscribed_user,
        character_cost_multiplier: (m.model_rates as Json | undefined)?.character_cost_multiplier,
      }))
    : [];
  await writeJson("models.json", { status: models.status, models: modelRows });

  // 5. Biblioteca compartida: español, por género y por cada orden.
  const queries: Json[] = [];
  const seen = new Map<string, Json & { ranks: Record<string, number> }>();
  for (const gender of GENDERS) {
    for (const sort of SORTS) {
      const q = `/v1/shared-voices?language=es&gender=${gender}&sort=${sort}&page_size=100`;
      const r = await get(q, apiKey);
      const voices = Array.isArray((r.body as Json)?.voices) ? ((r.body as Json).voices as Json[]) : [];
      queries.push({ query: q, status: r.status, count: voices.length, has_more: (r.body as Json)?.has_more ?? null, error: r.status === 200 ? null : r.body });
      console.log(`[query] ${r.status} ${voices.length} voces — ${q}`);
      voices.forEach((v, i) => {
        const id = str(v.voice_id);
        const prev = seen.get(id);
        const entry = prev ?? { ...v, ranks: {} };
        entry.ranks[`${gender}:${sort}`] = i + 1;
        seen.set(id, entry);
      });
    }
  }
  // Búsquedas complementarias (perfiles que la descripción no siempre nombra). Un parámetro no admitido queda registrado con su estado HTTP.
  const extra = [
    ...["narrador", "documental", "locutor", "grave", "deep", "podcast", "cálida", "storyteller"].map((t) => `search=${encodeURIComponent(t)}`),
    ...["narrative_story", "conversational", "informative_educational"].map((u) => `use_cases=${u}`),
  ];
  for (const gender of GENDERS) {
    for (const e of extra) {
      const q = `/v1/shared-voices?language=es&gender=${gender}&${e}&sort=usage_character_count_1y&page_size=50`;
      const r = await get(q, apiKey);
      const voices = Array.isArray((r.body as Json)?.voices) ? ((r.body as Json).voices as Json[]) : [];
      queries.push({ query: q, status: r.status, count: voices.length, error: r.status === 200 ? null : r.body });
      console.log(`[query] ${r.status} ${voices.length} voces — ${q}`);
      voices.forEach((v) => {
        const id = str(v.voice_id);
        const entry = seen.get(id) ?? { ...v, ranks: {} };
        entry.ranks[`${gender}:${e}`] = (entry.ranks[`${gender}:${e}`] ?? 0) || voices.indexOf(v) + 1;
        seen.set(id, entry);
      });
    }
  }
  await writeJson("queries.json", queries);

  // 6. Candidatas con métricas, condiciones e idiomas verificados.
  const rows = [...seen.values()].map((v) => {
    const scores = Object.fromEntries((Object.keys(PROFILES) as Profile[]).map((p) => [p, profileScore(v, p)]));
    return {
      voice_id: v.voice_id,
      public_owner_id: v.public_owner_id,
      name: v.name,
      gender: v.gender,
      age: v.age,
      accent: v.accent,
      locale: v.locale,
      language: v.language,
      category: v.category,
      descriptive: v.descriptive,
      use_case: v.use_case,
      description: typeof v.description === "string" ? v.description.slice(0, 300) : null,
      usage_character_count_1y: num(v.usage_character_count_1y),
      usage_character_count_7d: num(v.usage_character_count_7d),
      cloned_by_count: num(v.cloned_by_count),
      ranks: v.ranks,
      surcharges: surcharges(v),
      conditions: conditions(v),
      rate: v.rate ?? null,
      fiat_rate: v.fiat_rate ?? null,
      notice_period: v.notice_period ?? null,
      live_moderation_enabled: v.live_moderation_enabled ?? null,
      free_users_allowed: v.free_users_allowed ?? null,
      verified_languages: verifiedLanguages(v),
      preview_url: v.preview_url ?? null,
      is_mateo: v.voice_id === MATEO_ID,
      scores,
    };
  });
  await writeJson("candidates.json", rows);

  // Tabla medida (no heurística): las 25 más usadas en el último año por género, con sus métricas tal como las da la API.
  for (const gender of GENDERS) {
    const top = rows
      .filter((r) => r.gender === gender && !r.is_mateo)
      .sort((a, b) => (b.usage_character_count_1y ?? -1) - (a.usage_character_count_1y ?? -1))
      .slice(0, 25);
    console.log(`\n[top-uso-1y ${gender}] voice_id | nombre | uso 1a | uso 7d | clonada por | pos. uso/tendencia/clonación | acento/locale | descriptivo | caso de uso | idiomas verificados | condiciones`);
    for (const r of top) {
      const langs = r.verified_languages.map((l) => `${l.language}-${l.locale || l.accent}`).join(",");
      const rk = [`${gender}:usage_character_count_1y`, `${gender}:trending`, `${gender}:cloned_by_count`].map((k) => r.ranks[k] ?? "-").join("/");
      console.log(
        `[row ${gender}] ${r.voice_id} | ${r.name} | ${r.usage_character_count_1y ?? "?"} | ${r.usage_character_count_7d ?? "?"} | ${r.cloned_by_count ?? "?"} | ${rk} | ${r.accent ?? "?"}/${r.locale ?? "?"} | ${r.descriptive ?? "?"} | ${r.use_case ?? "?"} | ${langs} | ${r.surcharges.join("; ") || "sin recargos"} | ${r.conditions.join("; ") || "-"}`,
      );
    }
  }

  // Previews de las 12 más usadas por género (además de la preselección por perfil), con métricas acústicas.
  const byUsage: typeof rows = [];
  for (const gender of GENDERS) {
    byUsage.push(
      ...rows
        .filter((r) => r.gender === gender && !r.is_mateo && r.surcharges.length === 0)
        .sort((a, b) => (b.usage_character_count_1y ?? -1) - (a.usage_character_count_1y ?? -1))
        .slice(0, 12),
    );
  }
  const usageAcoustic: Json[] = [];
  for (const r of byUsage) {
    if (typeof r.preview_url !== "string" || !r.preview_url) continue;
    const file = path.join(OUT, "previews", `top_${r.gender}__${String(r.name).replace(/[^a-z0-9]+/gi, "_").slice(0, 30)}__${r.voice_id}.mp3`);
    try {
      const res = await fetch(r.preview_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
      const m = await acoustic(file);
      usageAcoustic.push({ voice_id: r.voice_id, name: r.name, gender: r.gender, ...m });
      console.log(`[acoustic-top] ${r.gender} ${r.voice_id} ${r.name}: ${JSON.stringify(m)}`);
    } catch (err) {
      console.log(`[acoustic-top] ${r.voice_id} error ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  await writeJson("acoustic-top-usage.json", usageAcoustic);

  // 7. Preselección por perfil (heurística declarada) + previews.
  const shortlist: Json = {};
  const acousticRows: Json[] = [];
  for (const profile of Object.keys(PROFILES) as Profile[]) {
    const ranked = rows
      .filter((r) => !r.is_mateo && r.scores[profile].score >= 0)
      .sort((a, b) => b.scores[profile].score - a.scores[profile].score || (b.usage_character_count_1y ?? 0) - (a.usage_character_count_1y ?? 0))
      .slice(0, 4);
    shortlist[profile] = ranked.map((r) => ({ voice_id: r.voice_id, name: r.name, score: r.scores[profile] }));
    for (const r of ranked) {
      const previews: { lang: string; url: string }[] = [];
      if (typeof r.preview_url === "string" && r.preview_url) previews.push({ lang: "default", url: r.preview_url });
      for (const l of r.verified_languages) if ((l.language === "es" || l.language === "en") && l.preview) previews.push({ lang: `${l.language}-${l.locale || l.accent || "x"}`, url: l.preview });
      const uniq = previews.filter((p, i) => previews.findIndex((q) => q.url === p.url) === i);
      for (const p of uniq.slice(0, 3)) {
        const safe = `${profile}__${String(r.name).replace(/[^a-z0-9]+/gi, "_").slice(0, 30)}__${r.voice_id}__${p.lang}`.replace(/_+/g, "_");
        const file = path.join(OUT, "previews", `${safe}.mp3`);
        try {
          const res = await fetch(p.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
          acousticRows.push({ profile, voice_id: r.voice_id, name: r.name, preview: p.lang, file: path.basename(file), ...(await acoustic(file)) });
        } catch (err) {
          acousticRows.push({ profile, voice_id: r.voice_id, name: r.name, preview: p.lang, error: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }
  // Mateo como referencia acústica.
  let mateo: { name: unknown; preview_url: unknown } | undefined = rows.find((r) => r.is_mateo);
  if (!mateo) {
    const own = await get(`/v1/voices/${MATEO_ID}`, apiKey);
    if (own.status === 200) mateo = { name: (own.body as Json).name, preview_url: (own.body as Json).preview_url };
    console.log(`[mateo] GET /v1/voices/${MATEO_ID}: ${own.status}`);
  }
  if (mateo && typeof mateo.preview_url === "string") {
    const file = path.join(OUT, "previews", `reference__Mateo__${MATEO_ID}.mp3`);
    const res = await fetch(mateo.preview_url);
    if (res.ok) {
      await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
      acousticRows.push({ profile: "reference", voice_id: MATEO_ID, name: mateo.name, file: path.basename(file), ...(await acoustic(file)) });
    }
  }
  // Finalistas elegidas a partir de la tabla medida: métricas crudas, inglés verificado, acceso desde esta cuenta (GET) y acústica.
  const FINALISTS = (process.env.VOICE_FINALISTS ??
    "k8cFOyAg7B9qwBlDDNTC,l1zE9xgNpUTaQCZzpNJa,sKgg4MPUDBy69X7iv3fA,8mBRP99B2Ng2QwsJMFQl,FrrTxu4nrplZwLlMy2kD,94zOad0g7T7K4oa7zhDq,htFfPSZGJwjBv1CL0aMD,iDEmt5MnqUotdwCIVplo,dlGxemPxFMTY7iXagmOj,kcQkGnn0HAT2JRDQ4Ljp,CaJslL1xziwefCeTNzHv,qHkrJuifPpn95wK3rm2A,2rigMbVWLdqtBSCahJFX,x5IDPSl4ZUbhosMmVFTk,GJid0jgRsqjUy21Avuex,p7AwDmKvTdoHTBuueGvP,2Lb1en5ujrODDIqmp7F3,m7yTemJqdIqrcNleANfX")
    .split(",").map((x) => x.trim()).filter(Boolean);
  const finalists: Json[] = [];
  for (const id of FINALISTS) {
    const r = rows.find((x) => x.voice_id === id);
    const access = await get(`/v1/voices/${id}`, apiKey);
    const row: Json = {
      voice_id: id,
      name: r?.name ?? null,
      in_library_results: Boolean(r),
      account_get_status: access.status,
      in_my_voices: myVoices.some((v) => v.voice_id === id),
      gender: r?.gender, accent: r?.accent, locale: r?.locale, descriptive: r?.descriptive, use_case: r?.use_case,
      usage_1y: r?.usage_character_count_1y, usage_7d: r?.usage_character_count_7d, cloned_by: r?.cloned_by_count, ranks: r?.ranks,
      rate: r?.rate, fiat_rate: r?.fiat_rate, notice_period: r?.notice_period, live_moderation_enabled: r?.live_moderation_enabled, free_users_allowed: r?.free_users_allowed,
      verified_en: r ? r.verified_languages.filter((l) => l.language === "en").map((l) => `${l.locale || l.accent}/${l.model}`) : [],
      verified_es: r ? r.verified_languages.filter((l) => l.language === "es").map((l) => `${l.locale || l.accent}/${l.model}`) : [],
    };
    const urls: { tag: string; url: string }[] = [];
    if (r && typeof r.preview_url === "string" && r.preview_url) urls.push({ tag: "default", url: r.preview_url });
    const en = r?.verified_languages.find((l) => l.language === "en" && l.preview);
    if (en) urls.push({ tag: "en", url: en.preview });
    for (const u of urls) {
      const file = path.join(OUT, "previews", `finalist__${String(r?.name ?? id).replace(/[^a-z0-9]+/gi, "_").slice(0, 30)}__${id}__${u.tag}.mp3`);
      try {
        const res = await fetch(u.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
        row[`acoustic_${u.tag}`] = await acoustic(file);
      } catch (err) {
        row[`acoustic_${u.tag}`] = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    finalists.push(row);
    console.log(`[finalist] ${JSON.stringify(row)}`);
  }
  await writeJson("finalists.json", finalists);
  await writeJson("shortlist.json", shortlist);
  await writeJson("acoustic.json", acousticRows);
  console.log(`[shortlist] ${JSON.stringify(shortlist)}`);
  console.log(`[acoustic] ${JSON.stringify(acousticRows)}`);
  console.log("Solo lectura: ninguna síntesis, ninguna voz agregada ni eliminada.");
}

main().catch((err) => {
  console.error("Investigación de voces detenida:", err instanceof Error ? err.message : err);
  process.exit(1);
});
