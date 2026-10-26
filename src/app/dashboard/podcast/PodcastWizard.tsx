"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { createClient } from "@/lib/supabase/client";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { classifyClientFetchError } from "@/lib/http/client-error";
import { MODE_LABEL, MOODS, MOOD_LABEL, SETS, SET_LABEL } from "@/lib/podcast/v3/spec";
import { CONSENT_TEXT, INTENSITY_DB, MODALITIES, MODALITY_LABEL, STEP, STEPS, STUDIO_BUDGET_MAX_USD, WIZARD_STORAGE_KEY, defaultDraft, draftToSpec, draftToV2, estimateMinutes, loadDraft, modalityToMode, stepErrors, type Modality, type WizardDraft } from "@/lib/podcast/v3/wizard";
import type { VisualProvider } from "@/lib/podcast/v3/studio";

export type WizardVoice = { voiceId: string; name: string; available: boolean; note: string | null };
export type WizardAvatar = { id: string; name: string };
type LipSeg = { start: number; end: number; shot: string; speaker: "A" | "B" | null; lips: { A: string; B: string } };
type Estimate = { lines: { concept: string; detail: string; usd: number; provider: string }[]; totalUsd: number; assumptions: string[]; turns: number; mood: string; shots: Record<string, number>; overBudget: boolean; byProvider?: Record<string, number>; lipTimeline?: LipSeg[]; coverage?: Record<string, boolean>; turnList?: { id: string; speaker: "A" | "B"; kind: string; text: string }[] };
type Status = { episode: { status: string; progress: { stage: string; pct: number } | null; error: string | null; cost_usd: number | null }; video_url: string | null; audio_url: string | null };

const USD = (n: number) => `USD ${n.toFixed(2)}`;
const MODE_HELP: Record<Modality, string> = {
  audio: "Una o dos voces, música opcional y exportación a MP3 o WAV. No se genera video (el más barato).",
  visual: "Una o dos voces con imágenes relacionadas, transiciones y música. Se entrega un MP4 y el audio por separado.",
  avatar: "Un presentador virtual (tu avatar) aparece hablando en tramos cortos, alternado con imágenes o clips de apoyo.",
  dialogo: "Dos participantes conversan (anfitrión e invitado), cada uno con su avatar y su voz: plano general de los dos y primeros planos.",
};
const SHOT_LABEL: Record<string, string> = { avatar_a: "Primer plano A", avatar_b: "Primer plano B", two_shot: "Plano general (los dos)", over_shoulder: "Sobre el hombro", imagen: "Imagen", recreacion: "Recreación", archivo: "Archivo", transicion: "Transición", titulo: "Título" };
const KIND_LABEL: Record<string, string> = { pregunta: "pregunta", respuesta: "respuesta", comentario: "comentario", reaccion: "reacción", desacuerdo: "desacuerdo", transicion: "transición", apertura: "apertura", cierre: "cierre", narracion: "narración" };
const STAGE: Record<string, string> = { voz: "Generando voces", musica: "Mezclando música", video: "Componiendo el video", listo: "Listo" };

export function PodcastWizard({ voices, avatars, v2Enabled, v3Enabled, generationEnabled = v3Enabled, providers = [], previewNotice = null }: { voices: WizardVoice[]; avatars: WizardAvatar[]; v2Enabled: boolean; v3Enabled: boolean; generationEnabled?: boolean; providers?: VisualProvider[]; previewNotice?: string | null }) {
  const router = useRouter();
  const [d, setD] = useState<WizardDraft>(defaultDraft);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  // Borrador persistente: volver atrás o recargar no pierde nada.
  // Hidratación desde localStorage (solo existe en el cliente): un único setState al montar.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setD(loadDraft(localStorage.getItem(WIZARD_STORAGE_KEY))); setLoaded(true); }, []);
  useEffect(() => { if (loaded) localStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(d)); }, [d, loaded]);
  const set = (patch: Partial<WizardDraft>) => setD((x) => ({ ...x, ...patch }));
  const setP = (i: 0 | 1, patch: Partial<WizardDraft["participants"][0]>) => setD((x) => { const ps = [...x.participants] as WizardDraft["participants"]; ps[i] = { ...ps[i], ...patch }; return { ...x, participants: ps }; });
  const unavailable = voices.filter((v) => !v.available).map((v) => v.voiceId);
  const errs = stepErrors(d, d.step, { unavailableVoices: unavailable, providers });
  const studio = v3Enabled; // sin estudio, «Solo audio» usa el flujo actual (Podcast 2.x) y los modos con avatar quedan en espera
  const modeBlocked = !generationEnabled && d.mode !== null && (studio || d.modality !== "audio");

  async function api(url: string, body?: unknown) {
    const res = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await safeParseJsonResponse<Record<string, unknown>>(res);
    if (!out.ok) throw new Error(out.error);
    return out.data;
  }
  async function run(fn: () => Promise<void>) { if (busy) return; setBusy(true); setError(null); try { await fn(); } catch (e) { setError(e instanceof Error && e.message ? e.message : classifyClientFetchError(e)); } finally { setBusy(false); } }
  const go = (step: number) => { setError(null); set({ step }); };
  const next = () => { if (errs.length) { setError(errs[0]); return; } if (d.step === STEP.visuales) void loadEstimate(); go(d.step + 1); };

  async function loadEstimate() {
    await run(async () => { const r = await api("/api/podcast/v3", { action: "estimate", spec: draftToSpec(d) }); setEstimate(r.estimate as Estimate); });
  }
  async function generateScript() {
    await run(async () => {
      const r = await api("/api/podcast/v3", { action: "script", topic: d.topic, hostName: d.participants[0].name, guestName: d.participants[1].name, guestRole: d.participants[1].role, hostPersonality: d.participants[0].personality, guestPersonality: d.participants[1].personality, minutes: d.minutes, useAi: true });
      set({ script: String(r.script) }); setNote(r.source === "llm" ? "Conversación generada con IA. Revísala antes de seguir." : `Conversación creada con la plantilla (sin costo).${r.note ? " " + r.note : ""}`);
    });
  }
  async function uploadPhoto(i: 0 | 1, file: File) {
    await run(async () => {
      const t = await api("/api/podcast/v3", { action: "photo-ticket", mime: file.type, size: file.size });
      const { error: e } = await createClient().storage.from("videos").uploadToSignedUrl(String(t.path), String(t.token), file, { contentType: file.type });
      if (e) throw new Error("No se pudo subir la foto.");
      setP(i, { avatar: { kind: "foto", photo_path: String(t.path), consent: false, consent_at: null } });
    });
  }
  async function authorizeAndGenerate() {
    if (!d.authorized) { setError("Marca la casilla para autorizar el cargo."); return; }
    await run(async () => {
      if (!generationEnabled && !studio && d.modality === "audio") {
        const r = await api("/api/podcast", draftToV2(d, v2Enabled));
        localStorage.removeItem(WIZARD_STORAGE_KEY);
        router.push(`/dashboard/podcast/${String(r.id)}`);
        return;
      }
      // El borrador creado se guarda aparte: el paso de progreso solo aparece cuando la autorización quedó registrada.
      const created = d.draftId ? { id: d.draftId } : await api("/api/podcast/v3", { action: "create", spec: draftToSpec(d) });
      set({ draftId: String(created.id) });
      const r = await api(`/api/podcast/v3/${String(created.id)}`, { confirm: true, authorizedUsd: d.budgetUsd });
      if (r.note) setNote(String(r.note));
      set({ step: STEP.generacion, episodeId: String(created.id) });
    });
  }
  // Tras recargar en Presupuesto/Vista previa, la estimación (gratis, sin red de pago) se recalcula sola.
  useEffect(() => { if (loaded && d.step >= STEP.presupuesto && d.step <= STEP.vista && !estimate && !busy) void loadEstimate(); }, [loaded, d.step]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!d.episodeId || d.step < STEP.generacion) return;
    const tick = async () => { try { const s = (await api(`/api/podcast/v3/${d.episodeId}`)) as unknown as Status; setStatus(s); if (s.episode.status === "ready" || s.episode.status === "failed") { if (poll.current) clearInterval(poll.current); } } catch { /* reintenta en el siguiente ciclo */ } };
    void tick(); poll.current = setInterval(tick, 4000);
    return () => { if (poll.current) clearInterval(poll.current); };
  }, [d.episodeId, d.step]);

  const input = "w-full rounded border border-border-strong bg-surface-raised px-3 py-2 text-base sm:text-sm";
  const choice = (on: boolean) => `rounded-lg border p-3 text-left text-sm ${on ? "border-accent bg-surface" : "border-border"}`;
  const active = d.participants.slice(0, d.count);
  const tag = (i: number) => (i === 0 ? "A" : "B");
  const started = !!d.episodeId;
  return (
    <Card className="mt-4 p-3 sm:p-4" data-testid="podcast-wizard" data-hydrated={loaded ? "1" : "0"} aria-busy={!loaded}>
      {previewNotice && <p className="mb-2 rounded bg-surface p-2 text-xs text-ink-muted" data-testid="preview-notice">{previewNotice}</p>}
      <ol className="flex gap-1 overflow-x-auto pb-1 text-xs" aria-label="Pasos">
        {STEPS.map((s, i) => (
          <li key={s} className="shrink-0"><button type="button" onClick={() => i <= d.step && !(started && i < STEP.generacion && busy) && go(i)} disabled={i > d.step} aria-current={i === d.step ? "step" : undefined}
            className={`rounded px-2 py-1 ${i === d.step ? "bg-accent text-accent-ink" : i < d.step ? "bg-surface text-ink" : "text-ink-muted"}`}>{i + 1}. {s}</button></li>
        ))}
      </ol>
      <h2 className="mt-3 text-lg font-semibold text-ink" data-testid="wizard-step-title">Paso {d.step + 1} de {STEPS.length}: {STEPS[d.step]}</h2>

      {d.step === STEP.modalidad && (
        <div className="mt-3 grid gap-2" role="radiogroup" aria-label="Modalidad">
          {MODALITIES.map((m) => (
            <button key={m} type="button" role="radio" aria-checked={d.modality === m} className={choice(d.modality === m)} data-testid={`modalidad-${m}`}
              onClick={() => set({ modality: m, mode: modalityToMode(m), count: m === "dialogo" ? 2 : m === "avatar" ? 1 : d.count })}>
              <span className="font-medium text-ink">{MODALITY_LABEL[m]}</span><br /><span className="text-ink-muted">{MODE_HELP[m]}</span>
              {!studio && m !== "audio" && <span className="mt-1 block text-xs text-danger">Disponible cuando se active el estudio (pendiente de autorización).</span>}
            </button>
          ))}
        </div>
      )}

      {d.step === STEP.tema && (
        <div className="mt-3 grid gap-3 text-sm">
          <label>Título<input aria-label="Título del episodio" value={d.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} className={input} /></label>
          <label>Tema<input aria-label="Tema" value={d.topic} maxLength={500} onChange={(e) => set({ topic: e.target.value })} className={input} placeholder="Por ejemplo: el misterio de la señal Wow!" /></label>
          <label>Idioma<select aria-label="Idioma" value={d.language} onChange={(e) => set({ language: e.target.value as "es" | "en" })} className={input}><option value="es">Español</option><option value="en">Inglés</option></select></label>
          <label>Duración objetivo: {d.minutes} min<input aria-label="Duración en minutos" type="range" min={1} max={30} value={d.minutes} onChange={(e) => set({ minutes: Number(e.target.value) })} className="w-full" /></label>
          {d.mode === "dialogo" && <Button type="button" variant="secondary" size="sm" onClick={generateScript} loading={busy} disabled={d.topic.trim().length < 3}>Generar conversación desde el tema</Button>}
          <label>{d.mode === "dialogo" ? "Guion (una línea por turno: «Nombre: texto»)" : "Texto del episodio (un párrafo por idea)"}
            <textarea aria-label="Guion" value={d.script} rows={8} onChange={(e) => set({ script: e.target.value })} className={input} /></label>
          <p className="text-xs text-ink-muted">{d.script.trim().length.toLocaleString("es-MX")} caracteres · ~{estimateMinutes(d.script).toFixed(1)} min de voz{estimateMinutes(d.script) < d.minutes * 0.7 ? " · más corto que la duración elegida" : ""}</p>
        </div>
      )}

      {d.step === STEP.participantes && (
        <div className="mt-3 grid gap-3 text-sm">
          {(d.modality === "audio" || d.modality === "visual") && (
            <div className="flex flex-wrap gap-4" role="radiogroup" aria-label="Número de voces">
              <label><input type="radio" checked={d.count === 1} onChange={() => set({ count: 1 })} /> Una voz</label>
              <label><input type="radio" checked={d.count === 2} onChange={() => set({ count: 2 })} /> Dos voces que se alternan</label>
            </div>
          )}
          {active.map((p, i) => (
            <fieldset key={i} className="grid gap-2 rounded border border-border p-2">
              <legend className="px-1">{i === 0 ? (d.mode === "dialogo" ? "Participante A (anfitrión)" : "Participante principal") : "Participante B (invitado o segunda voz)"}</legend>
              <label>Nombre<input aria-label={`Nombre ${tag(i)}`} value={p.name} maxLength={60} onChange={(e) => setP(i as 0 | 1, { name: e.target.value })} className={input} /></label>
              <label>Rol<input aria-label={`Rol ${tag(i)}`} value={p.role} maxLength={120} onChange={(e) => setP(i as 0 | 1, { role: e.target.value })} className={input} placeholder={i === 0 ? "Anfitrión" : "Experta invitada"} /></label>
              <label>Género / estilo de voz<select aria-label={`Género ${tag(i)}`} value={p.gender} onChange={(e) => setP(i as 0 | 1, { gender: e.target.value as WizardDraft["participants"][0]["gender"] })} className={input}><option value="neutro">Neutro</option><option value="femenino">Femenino</option><option value="masculino">Masculino</option></select></label>
              <label>Estilo<input aria-label={`Estilo ${tag(i)}`} value={p.style} maxLength={80} onChange={(e) => setP(i as 0 | 1, { style: e.target.value })} className={input} placeholder="Cálido, pausado" /></label>
              <label>Personalidad<input aria-label={`Personalidad ${tag(i)}`} value={p.personality} maxLength={160} onChange={(e) => setP(i as 0 | 1, { personality: e.target.value })} className={input} placeholder={i === 0 ? "Curioso, hace preguntas" : "Escéptica, discrepa con datos"} /></label>
            </fieldset>
          ))}
        </div>
      )}

      {d.step === STEP.voces && (
        <div className="mt-3 grid gap-3 text-sm">
          {active.map((p, i) => (
            <label key={i}>Voz de {p.name}
              <select aria-label={`Voz ${tag(i)}`} value={p.voice_id} onChange={(e) => setP(i as 0 | 1, { voice_id: e.target.value })} className={input}>
                <option value="">Elige una voz…</option>
                {voices.map((v) => <option key={v.voiceId} value={v.voiceId} disabled={!v.available}>{v.name}{v.note ? ` — ${v.note}` : ""}</option>)}
              </select>
            </label>
          ))}
          {voices.some((v) => !v.available) && <p className="text-xs text-ink-muted">Las voces marcadas «No disponible» no se pueden usar y nunca se reemplazan por otra.</p>}
        </div>
      )}

      {d.step === STEP.avatares && (
        <div className="mt-3 grid gap-3 text-sm">
          {d.mode === "narracion" ? <p className="text-ink-muted" data-testid="avatares-no-aplica">{d.modality === "audio" ? "Solo audio" : "Narración con imágenes"}: no se usan avatares. Puedes seguir.</p> : active.map((p, i) => (
            <fieldset key={i} className="rounded border border-border p-2">
              <legend className="px-1">Avatar de {p.name}</legend>
              <select aria-label={`Avatar ${tag(i)}`} value={p.avatar.kind === "existente" ? p.avatar.avatar_id : p.avatar.kind === "foto" ? "__foto" : ""}
                onChange={(e) => setP(i as 0 | 1, { avatar: e.target.value === "__foto" ? { kind: "foto", photo_path: "", consent: false, consent_at: null } : e.target.value ? { kind: "existente", avatar_id: e.target.value } : { kind: "ninguno" } })} className={input}>
                <option value="">Elige…</option>
                {avatars.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                <option value="__foto">Crear desde una foto</option>
              </select>
              {p.avatar.kind === "foto" && (
                <div className="mt-2 grid gap-1">
                  <input aria-label={`Foto ${tag(i)}`} type="file" accept="image/jpeg,image/png" onChange={(e) => e.target.files?.[0] && uploadPhoto(i as 0 | 1, e.target.files[0])} />
                  {p.avatar.photo_path && <span className="text-xs text-ink-muted">Foto subida.</span>}
                  <label className="text-xs"><input type="checkbox" aria-label={`Consentimiento ${tag(i)}`} checked={p.avatar.consent} onChange={(e) => setP(i as 0 | 1, { avatar: { ...(p.avatar as Extract<typeof p.avatar, { kind: "foto" }>), consent: e.target.checked, consent_at: e.target.checked ? new Date().toISOString() : null } })} /> {CONSENT_TEXT}</label>
                </div>
              )}
            </fieldset>
          ))}
          {d.mode !== "narracion" && (<>
            <label>Frecuencia del avatar: {Math.round(d.avatarFrequency * 100)}% de los turnos<input aria-label="Frecuencia del avatar" type="range" min={0.1} max={1} step={0.1} value={d.avatarFrequency} onChange={(e) => set({ avatarFrequency: Number(e.target.value) })} className="w-full" /></label>
            <label>Duración máxima por aparición: {d.avatarMaxSeconds} s<input aria-label="Duración máxima del avatar" type="range" min={5} max={60} step={5} value={d.avatarMaxSeconds} onChange={(e) => set({ avatarMaxSeconds: Number(e.target.value) })} className="w-full" /></label>
            <p className="text-xs text-ink-muted">Segmentos cortos de avatar = menor costo. Solo mueve los labios quien habla; el otro queda en reposo. Cada avatar se genera por separado y se reutiliza.</p>
          </>)}
        </div>
      )}

      {d.step === STEP.musica && (
        <div className="mt-3 grid gap-3 text-sm">
          <label><input type="checkbox" aria-label="Música de fondo" checked={d.musicEnabled} onChange={(e) => set({ musicEnabled: e.target.checked })} /> Música de fondo (biblioteca propia con licencia CC0)</label>
          {d.musicEnabled && (<>
            <label>Estilo musical<select aria-label="Ambiente musical" value={d.mood} onChange={(e) => set({ mood: e.target.value as WizardDraft["mood"] })} className={input}>
              <option value="auto">Automático según el guion</option>{MOODS.map((m) => <option key={m} value={m}>{MOOD_LABEL[m]}</option>)}</select></label>
            <label>Intensidad<select aria-label="Intensidad de la música" value={d.intensity} onChange={(e) => { const v = e.target.value as WizardDraft["intensity"]; set({ intensity: v, volumeDb: INTENSITY_DB[v] }); }} className={input}>
              <option value="suave">Suave</option><option value="media">Media</option><option value="alta">Alta</option></select></label>
            <label><input type="checkbox" aria-label="Cortina de entrada" checked={d.intro} onChange={(e) => set({ intro: e.target.checked })} /> Cortina de entrada (intro)</label>
            <label><input type="checkbox" aria-label="Cortina de cierre" checked={d.outro} onChange={(e) => set({ outro: e.target.checked })} /> Cortina de cierre (outro)</label>
            <label><input type="checkbox" aria-label="Transiciones musicales" checked={d.stings} onChange={(e) => set({ stings: e.target.checked })} /> Transiciones entre bloques</label>
            <label><input type="checkbox" aria-label="Ducking bajo el diálogo" checked={d.ducking} onChange={(e) => set({ ducking: e.target.checked })} /> Bajar la música cuando alguien habla (ducking)</label>
            <label>Sonido ambiente<select aria-label="Sonido ambiente" value={d.ambient} onChange={(e) => set({ ambient: e.target.value as WizardDraft["ambient"] })} className={input}>
              <option value="ninguno">Ninguno</option><option value="lluvia">Lluvia</option><option value="viento">Viento</option><option value="noche">Noche</option></select></label>
          </>)}
          <p className="text-xs text-ink-muted">El audio final se ajusta a −16 LUFS (pico real ≤ −1 dBTP).</p>
        </div>
      )}

      {d.step === STEP.visuales && (
        <div className="mt-3 grid gap-3 text-sm">
          {d.modality === "audio" ? <p className="text-ink-muted" data-testid="solo-audio-sin-video">Solo audio: se exporta el archivo de audio. No se genera video ni se buscan imágenes.</p> : (
            <div className="grid gap-2" role="radiogroup" aria-label="Proveedor visual">
              {providers.map((p) => (
                <label key={p.id} className={choice(d.provider === p.id)} data-testid={`proveedor-${p.id}`}>
                  <input type="radio" name="proveedor" aria-label={p.label} checked={d.provider === p.id} onChange={() => set({ provider: p.id })} /> <b>{p.label}</b>{p.usdPerImage ? ` · USD ${p.usdPerImage}/imagen` : " · sin costo"}
                  {!p.available && <span className="mt-1 block text-xs text-danger">{p.reason}</span>}
                </label>
              ))}
            </div>
          )}
          {d.modality !== "audio" && (<>
          <label>Escenario<select aria-label="Escenario" value={d.set} onChange={(e) => set({ set: e.target.value as WizardDraft["set"] })} className={input}>{SETS.map((s) => <option key={s} value={s}>{SET_LABEL[s]}</option>)}</select></label>
          {d.mode === "dialogo" && <label><input type="checkbox" checked={d.swap} onChange={(e) => set({ swap: e.target.checked })} /> Invertir posiciones (anfitrión a la derecha)</label>}
          <label><input type="checkbox" checked={d.subtitles} onChange={(e) => set({ subtitles: e.target.checked })} /> Subtítulos</label>
          {d.provider === "recraft" && <label><input type="checkbox" checked={d.recreations} onChange={(e) => set({ recreations: e.target.checked })} /> Permitir recreaciones (se marcan «Recreación» en pantalla)</label>}
          <div className="flex flex-wrap gap-4" role="radiogroup" aria-label="Formato de video">
            <label><input type="radio" checked={d.format === "16:9"} onChange={() => set({ format: "16:9" })} /> Horizontal 16:9 (YouTube)</label>
            <label><input type="radio" checked={d.format === "9:16"} onChange={() => set({ format: "9:16" })} /> Vertical 9:16 (Reels/TikTok)</label>
          </div>
          </>)}
          <div className="flex flex-wrap gap-4" role="radiogroup" aria-label="Formato de audio">
            <label><input type="radio" checked={d.audioExport === "mp3"} onChange={() => set({ audioExport: "mp3" })} /> Audio MP3</label>
            <label><input type="radio" checked={d.audioExport === "wav"} onChange={() => set({ audioExport: "wav" })} /> Audio WAV</label>
          </div>
        </div>
      )}

      {d.step === STEP.presupuesto && (
        <div className="mt-3 grid gap-2 text-sm" data-testid="wizard-estimate">
          {!estimate ? <Button type="button" variant="secondary" size="sm" onClick={loadEstimate} loading={busy}>Calcular costo</Button> : (
            <>
              <div className="overflow-x-auto"><table className="w-full text-left text-xs sm:text-sm"><thead><tr><th>Concepto</th><th>Proveedor</th><th>Detalle</th><th className="text-right">USD</th></tr></thead><tbody>
                {estimate.lines.map((l) => <tr key={l.concept}><td>{l.concept}</td><td>{l.provider}</td><td className="text-ink-muted">{l.detail}</td><td className="text-right">{l.usd.toFixed(2)}</td></tr>)}
                <tr className="font-semibold"><td colSpan={3}>Total estimado</td><td className="text-right">{USD(estimate.totalUsd)}</td></tr>
              </tbody></table></div>
              {estimate.byProvider && <ul className="text-xs" data-testid="costo-por-proveedor" aria-label="Costo por proveedor">{Object.entries(estimate.byProvider).map(([k, v]) => <li key={k}>{k}: {USD(v)}</li>)}</ul>}
              <p className="text-xs text-ink-muted">{estimate.turns} turnos · música: {estimate.mood}. Supuestos: {estimate.assumptions.join(" ")}</p>
            </>
          )}
          <label>Presupuesto máximo del episodio (USD)<input aria-label="Presupuesto máximo" type="number" min={0.5} max={STUDIO_BUDGET_MAX_USD} step={0.5} value={d.budgetUsd} onChange={(e) => set({ budgetUsd: Number(e.target.value) })} className={input} /></label>
          {estimate && estimate.totalUsd > d.budgetUsd && <p className="text-danger">El costo estimado supera tu presupuesto: súbelo o reduce las apariciones del avatar.</p>}
          <p className="text-xs text-ink-muted">Nada se cobra en este paso. La autorización del cargo se pide al final, en «Generación».</p>
        </div>
      )}

      {d.step === STEP.vista && (
        <div className="mt-3 grid gap-2 text-sm" data-testid="wizard-preview">
          <p><b>{d.title}</b> · {d.modality ? MODALITY_LABEL[d.modality] : ""} · {d.minutes} min · {d.language === "es" ? "español" : "inglés"}</p>
          <p className="text-xs">Participantes: {active.map((p) => `${p.name} (${p.role || "sin rol"}${p.personality ? `, ${p.personality}` : ""})`).join(" · ")}</p>
          <p className="text-xs">Música: {d.musicEnabled ? `${d.mood === "auto" ? "automática" : MOOD_LABEL[d.mood as keyof typeof MOOD_LABEL]}, intensidad ${d.intensity}${d.intro ? ", intro" : ""}${d.outro ? ", outro" : ""}${d.ducking ? ", ducking" : ""}` : "sin música"} · −16 LUFS</p>
          {estimate?.coverage && d.mode === "dialogo" && <p className="text-xs" data-testid="cobertura-planos">Planos: {estimate.coverage.general ? "✔ plano general de los dos" : "✘ sin plano general"} · {estimate.coverage.primerPlanoA ? "✔" : "✘"} primer plano A · {estimate.coverage.primerPlanoB ? "✔" : "✘"} primer plano B</p>}
          {estimate?.turnList && (
            <ol className="max-h-64 overflow-y-auto rounded border border-border p-2 text-xs" aria-label="Turnos del guion" data-testid="preview-turnos">
              {estimate.turnList.map((t) => <li key={t.id}><b>{t.speaker === "A" ? d.participants[0].name : d.participants[1].name}</b> <span className="text-ink-muted">({KIND_LABEL[t.kind] ?? t.kind})</span>: {t.text}</li>)}
            </ol>
          )}
          {estimate?.lipTimeline && d.mode !== "narracion" && (
            <ol className="max-h-48 overflow-y-auto rounded border border-border p-2 text-xs" aria-label="Línea de tiempo de planos" data-testid="preview-timeline">
              {estimate.lipTimeline.map((s, i) => <li key={i}>{s.start.toFixed(0)}–{s.end.toFixed(0)} s · {SHOT_LABEL[s.shot] ?? s.shot} · labios A: {s.lips.A} · B: {s.lips.B}</li>)}
            </ol>
          )}
          <p className="font-semibold">Costo estimado: {estimate ? USD(estimate.totalUsd) : "—"} (tope {USD(d.budgetUsd)})</p>
        </div>
      )}

      {d.step === STEP.generacion && (
        <div className="mt-3 grid gap-2 text-sm">
          {!started && (modeBlocked ? <p className="text-danger" data-testid="generacion-bloqueada">{previewNotice ? "En esta vista previa la generación está desactivada: se activa con la migración propuesta y PODCAST_V3_ENABLED=1. La configuración queda guardada." : "Este modo se activa cuando el propietario autorice la migración y el interruptor del estudio."}</p> : (<>
            <p>Se generará «{d.title}» ({d.modality ? MODALITY_LABEL[d.modality] : MODE_LABEL[d.mode ?? "narracion"]}). Costo estimado: <b>{estimate ? USD(estimate.totalUsd) : "—"}</b>. Nunca se cobrará más de <b>{USD(d.budgetUsd)}</b>.</p>
            <label><input type="checkbox" aria-label="Autorizo el cargo" checked={d.authorized} onChange={(e) => set({ authorized: e.target.checked })} /> Autorizo generar este episodio con un cargo máximo de {USD(d.budgetUsd)}.</label>
            <Button type="button" onClick={authorizeAndGenerate} loading={busy} disabled={!d.authorized || (estimate?.totalUsd ?? 0) > d.budgetUsd}>Generar episodio</Button>
          </>))}
          {started && (
            <div data-testid="wizard-progress">
              <p>{status ? (status.episode.status === "failed" ? "No se pudo terminar. No se te cobra un episodio no entregado." : status.episode.status === "ready" ? "Listo" : STAGE[status.episode.progress?.stage ?? ""] ?? "En cola…") : "Iniciando…"}</p>
              <div className="mt-2 h-2 w-full rounded bg-surface"><div className="h-2 rounded bg-accent" style={{ width: `${status?.episode.status === "ready" ? 100 : status?.episode.progress?.pct ?? 2}%` }} /></div>
              {status?.episode.error && <p className="mt-2 text-danger">{status.episode.error}</p>}
              {status?.episode.status === "failed" && <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => { set({ draftId: d.episodeId, episodeId: null, authorized: false }); }}>Reintentar (no se cobra dos veces lo ya generado)</Button>}
              <p className="mt-2 text-xs text-ink-muted">Puedes cerrar esta página: el episodio sigue generándose y aparecerá en «Tus episodios».</p>
            </div>
          )}
          {status?.video_url && <video data-testid="wizard-player" src={status.video_url} controls playsInline className="w-full rounded" />}
          {status?.audio_url && <audio data-testid="wizard-audio-player" src={status.audio_url} controls className="w-full" />}
          {status?.video_url && <a className="text-accent underline" href={status.video_url} data-testid="wizard-download-mp4">Descargar video (MP4)</a>}
          {status?.audio_url && <a className="text-accent underline" href={status.audio_url} data-testid="wizard-download-audio">Descargar solo audio ({d.audioExport.toUpperCase()})</a>}
          {status?.episode.cost_usd != null && <p className="text-ink-muted">Costo registrado: {USD(Number(status.episode.cost_usd))}</p>}
        </div>
      )}

      {note && <p className="mt-3 text-sm text-ink-muted">{note}</p>}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <div className="sticky bottom-0 mt-4 flex justify-between gap-2 bg-canvas/95 py-2">
        <Button type="button" variant="ghost" size="sm" onClick={() => go(Math.max(0, d.step - 1))} disabled={d.step === 0 || busy}>Atrás</Button>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => { localStorage.removeItem(WIZARD_STORAGE_KEY); setD(defaultDraft()); setEstimate(null); setStatus(null); setNote(null); setError(null); router.refresh(); }}>Empezar de nuevo</Button>
          {d.step < STEP.generacion && <Button type="button" size="sm" onClick={next} disabled={busy}>Siguiente</Button>}
        </div>
      </div>
    </Card>
  );
}
