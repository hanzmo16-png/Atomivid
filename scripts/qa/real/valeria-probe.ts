/**
 * Solo lectura (USD 0): ¿sigue vivo el asset de imagen de Valeria en HeyGen y trae URL descargable? ¿Cómo está la voz
 * Callie en ElevenLabs (en la cuenta, en la biblioteca, permisos)? Imprime estructura y booleanos, no URLs firmadas.
 */
const out = (t: string, v: unknown) => console.log(t, JSON.stringify(v));
async function main() {
  const hk = process.env.HEYGEN_API_KEY ?? "", ek = process.env.ELEVENLABS_API_KEY ?? "";
  const ASSET = "dcf70e13d7b44cd2ad95836412120ab4", LOOK = "65465dcbf7b5655effcd2c503e6cb294", CALLIE = "7YaUDeaStRuoYg3FKsmU";
  for (const url of [`https://api.heygen.com/v3/assets/${ASSET}`, `https://api.heygen.com/v2/photo_avatar/${LOOK}`, `https://api.heygen.com/v2/avatar_group/${LOOK}/avatars`]) {
    const r = await fetch(url, { headers: { "X-Api-Key": hk } }); const j = await r.json().catch(() => null) as Record<string, unknown> | null;
    const d = (j?.data ?? j) as Record<string, unknown> | null;
    const keys = d && typeof d === "object" ? Object.keys(d) : [];
    const urlish = Object.fromEntries(Object.entries(d ?? {}).filter(([, v]) => typeof v === "string" && /^https?:/.test(v as string)).map(([k]) => [k, true]));
    out("HEYGEN", { path: new URL(url).pathname.replace(ASSET, "<asset>").replace(LOOK, "<look>"), http: r.status, keys, urlFields: urlish, status: (d as { status?: unknown } | null)?.status ?? null });
  }
  const v = await fetch(`https://api.elevenlabs.io/v1/voices/${CALLIE}`, { headers: { "xi-api-key": ek } }); const vj = await v.json().catch(() => null) as Record<string, unknown> | null;
  out("CALLIE_GET", { http: v.status, name: vj?.name ?? null, category: vj?.category ?? null, sharing: vj?.sharing ? { status: (vj.sharing as Record<string, unknown>).status, public_owner_id: !!(vj.sharing as Record<string, unknown>).public_owner_id } : null, is_owner: vj?.is_owner ?? null, labels: vj?.labels ?? null });
  const s = await fetch(`https://api.elevenlabs.io/v1/shared-voices?page_size=5&search=Callie`, { headers: { "xi-api-key": ek } }); const sj = await s.json().catch(() => null) as { voices?: Record<string, unknown>[] } | null;
  out("CALLIE_LIBRARY", { http: s.status, hits: (sj?.voices ?? []).map((x) => ({ voice_id_match: x.voice_id === CALLIE, name: x.name, language: x.language, accent: x.accent, gender: x.gender, has_owner: !!x.public_owner_id, free_users_allowed: x.free_users_allowed ?? null })) });
  const all = await fetch(`https://api.elevenlabs.io/v1/voices`, { headers: { "xi-api-key": ek } }); const aj = await all.json().catch(() => null) as { voices?: { voice_id: string }[] } | null;
  out("CALLIE_IN_ACCOUNT", { http: all.status, inAccount: (aj?.voices ?? []).some((x) => x.voice_id === CALLIE), count: aj?.voices?.length ?? null });
}
main().catch((e) => { console.error(e instanceof Error ? e.message : "error"); process.exitCode = 1; });
