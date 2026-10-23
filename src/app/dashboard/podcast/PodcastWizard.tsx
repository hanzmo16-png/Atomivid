"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { createClient } from "@/lib/supabase/client";
import { safeParseJsonResponse } from "@/lib/http/safe-json";
import { classifyClientFetchError } from "@/lib/http/client-error";
import { MODE_LABEL, MOODS, MOOD_LABEL, SETS, SET_LABEL, type StudioMode } from "@/lib/podcast/v3/spec";
import { CONSENT_TEXT, STEPS, WIZARD_STORAGE_KEY, defaultDraft, draftToSpec, draftToV2, estimateMinutes, loadDraft, stepErrors, type WizardDraft } from "@/lib/podcast/v3/wizard";

export type WizardVoice = { voiceId: string; name: string; available: boolean; note: string | null };
export type WizardAvatar = { id: string; name: string };
type Estimate = { lines: { concept: string; detail: string; usd: number; provider: string }[]; totalUsd: number; assumptions: string[]; turns: number; mood: string; shots: Record<string, number>; overBudget: boolean };
type Status = { episode: { status: string; progress: { stage: string; pct: number } | null; error: string | null; cost_usd: number | null }; video_url: string | null; audio_url: string | null };

const USD = (n: number) => `USD ${n.toFixed(2)}`;
const MODE_HELP: Record<StudioMode, string> = {
  narracion: "Una o dos voces narran la historia con imágenes relacionadas, música y transiciones suaves.",
  avatar: "Un presentador virtual (tu avatar) aparece hablando, alternado con imágenes. Tú controlas cuánto aparece.",
  dialogo: "Dos participantes conversan: tú (anfitrión) y un invitado, cada uno con su voz y su avatar.",
};
const STAGE: Record<string, string> = { voz: "Generando voces", musica: "Mezclando música", video: "Componiendo el video", listo: "Listo" };

export function PodcastWizard({ voices, avatars, v2Enabled, v3Enabled }: { voices: WizardVoice[]; avatars: WizardAvatar[]; v2Enabled: boolean; v3Enabled: boolean }) {
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
  useEffect(() => { setD(loadDraft(localStorage.getItem(WIZARD_STORAGE_KEY))); setLoaded(true); }, []);
  useEffect(() => { if (loaded) localStorage.setItem(WIZARD_STORAGE_KEY, JSON.stringify(d)); }, [d, loaded]);
  const set = (patch: Partial<WizardDraft>) => setD((x) => ({ ...x, ...patch }));
  const setP = (i: 0 | 1, patch: Partial<WizardDraft["participants"][0]>) => setD((x) => { const ps = [...x.participants] as WizardDraft["participants"]; ps[i] = { ...ps[i], ...patch }; return { ...x, participants: ps }; });
  const unavailable = voices.filter((v) => !v.available).map((v) => v.voiceId);
  const errs = stepErrors(d, d.step, { unavailableVoices: unavailable });
  const studio = v3Enabled; // sin estudio, el modo A usa el flujo actual (Podcast 2.x) y B/C quedan en espera
  const modeBlocked = !studio && d.mode !== null && d.mode !== "narracion";

  async function api(url: string, body?: unknown) {
    const res = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await safeParseJsonResponse<Record<string, unknown>>(res);
    if (!out.ok) throw new Error(out.error);
    return out.data;
  }
  async function run(fn: () => Promise<void>) { if (busy) return; setBusy(true); setError(null); try { await fn(); } catch (e) { setError(e instanceof Error && e.message ? e.message : classifyClientFetchError(e)); } finally { setBusy(false); } }
  const go = (step: number) => { setError(null); set({ step }); };
  const next = () => { if (errs.length) { setError(errs[0]); return; } if (d.step === 7) void loadEstimate(); go(d.step + 1); };

  async function loadEstimate() {
    await run(async () => { const r = await api("/api/podcast/v3", { action: "estimate", spec: draftToSpec(d) }); setEstimate(r.estimate as Estimate); });
  }
  async function generateScript() {
    await run(async () => {
      const r = await api("/api/podcast/v3", { action: "script", topic: d.topic, hostName: d.participants[0].name, guestName: d.participants[1].name, guestRole: d.participants[1].role, minutes: d.minutes, useAi: true });
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
      if (!studio && d.mode === "narracion") {
        const r = await api("/api/podcast", draftToV2(d, v2Enabled));
        localStorage.removeItem(WIZARD_STORAGE_KEY);
        router.push(`/dashboard/podcast/${String(r.id)}`);
        return;
      }
      const created = d.episodeId ? { id: d.episodeId } : await api("/api/podcast/v3", { action: "create", spec: draftToSpec(d) });
      set({ episodeId: String(created.id) });
      const r = await api(`/api/podcast/v3/${String(created.id)}`, { confirm: true, authorizedUsd: d.budgetUsd });
      if (r.note) setNote(String(r.note));
      set({ step: 10, episodeId: String(created.id) });
    });
  }
  useEffect(() => {
    if (!d.episodeId || d.step < 10) return;
    const tick = async () => { try { const s = (await api(`/api/podcast/v3/${d.episodeId}`)) as unknown as Status; setStatus(s); if (s.episode.status === "ready" || s.episode.status === "failed") { if (poll.current) clearInterval(poll.current); if (s.episode.status === "ready" && d.step === 10) set({ step: 11 }); } } catch { /* reintenta en el siguiente ciclo */ } };
    void tick(); poll.current = setInterval(tick, 4000);
    return () => { if (poll.current) clearInterval(poll.current); };
  }, [d.episodeId, d.step]); // eslint-disable-line react-hooks/exhaustive-deps

  const input = "w-full rounded border border-border-strong bg-surface-raised px-2 py-1 text-sm";
  const choice = (on: boolean) => `rounded-lg border p-3 text-left text-sm ${on ? "border-accent bg-surface" : "border-border"}`;
  const active = d.participants.slice(0, d.count);
  return (
    <Card className="mt-4 p-4" data-testid="podcast-wizard">
      <ol className="flex flex-wrap gap-1 text-xs" aria-label="Pasos">
        {STEPS.map((s, i) => (
          <li key={s}><button type="button" onClick={() => i <= d.step && go(i)} disabled={i > d.step || (i >= 10 && !d.episodeId)} aria-current={i === d.step ? "step" : undefined}
            className={`rounded px-2 py-0.5 ${i === d.step ? "bg-accent text-accent-ink" : i < d.step ? "bg-surface text-ink" : "text-ink-muted"}`}>{i + 1}. {s}</button></li>
        ))}
      </ol>
      <h2 className="mt-3 text-lg font-semibold text-ink" data-testid="wizard-step-title">Paso {d.step + 1} de {STEPS.length}: {STEPS[d.step]}</h2>

      {d.step === 0 && (
        <div className="mt-3 grid gap-2" role="radiogroup" aria-label="Modo">
          {(["narracion", "avatar", "dialogo"] as const).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={d.mode === m} className={choice(d.mode === m)}
              onClick={() => set({ mode: m, count: m === "dialogo" ? 2 : m === "avatar" ? 1 : d.count })}>
              <span className="font-medium text-ink">{MODE_LABEL[m]}</span><br /><span className="text-ink-muted">{MODE_HELP[m]}</span>
              {!studio && m !== "narracion" && <span className="mt-1 block text-xs text-danger">Disponible cuando se active el estudio (pendiente de autorización).</span>}
            </button>
          ))}
        </div>
      )}

      {d.step === 1 && (
        <div className="mt-3 grid gap-3 text-sm">
          <label>Título<input aria-label="Título del episodio" value={d.title} maxLength={200} onChange={(e) => set({ title: e.target.value })} className={input} /></label>
          <label>Tema (opcional)<input aria-label="Tema" value={d.topic} maxLength={500} onChange={(e) => set({ topic: e.target.value })} className={input} placeholder="Por ejemplo: el misterio de la señal Wow!" /></label>
          {d.mode === "dialogo" && <Button type="button" variant="secondary" size="sm" onClick={generateScript} loading={busy} disabled={d.topic.trim().length < 3}>Generar conversación desde el tema</Button>}
          <label>{d.mode === "dialogo" ? "Guion (una línea por turno: «Nombre: texto»)" : "Texto del episodio (un párrafo por idea)"}
            <textarea aria-label="Guion" value={d.script} rows={10} onChange={(e) => set({ script: e.target.value })} className={input} /></label>
          <p className="text-xs text-ink-muted">{d.script.trim().length.toLocaleString("es-MX")} caracteres · ~{estimateMinutes(d.script).toFixed(1)} min de voz</p>
        </div>
      )}

      {d.step === 2 && (
        <div className="mt-3 text-sm">
          <label>Duración objetivo: {d.minutes} min<input aria-label="Duración en minutos" type="range" min={1} max={30} value={d.minutes} onChange={(e) => set({ minutes: Number(e.target.value) })} className="w-full" /></label>
          <p className="text-ink-muted">Tu texto actual dura ~{estimateMinutes(d.script).toFixed(1)} min. {estimateMinutes(d.script) < d.minutes * 0.7 ? "Es más corto que la duración elegida: puedes ampliarlo o dejarlo así." : ""}</p>
        </div>
      )}

      {d.step === 3 && (
        <div className="mt-3 grid gap-3 text-sm">
          {d.mode === "narracion" && (
            <div className="flex gap-4" role="radiogroup" aria-label="Número de voces">
              <label><input type="radio" checked={d.count === 1} onChange={() => set({ count: 1 })} /> Una voz</label>
              <label><input type="radio" checked={d.count === 2} onChange={() => set({ count: 2 })} /> Dos voces que se alternan</label>
            </div>
          )}
          {active.map((p, i) => (
            <fieldset key={i} className="rounded border border-border p-2">
              <legend className="px-1">{i === 0 ? (d.mode === "dialogo" ? "Participante A (tú, anfitrión)" : "Participante principal") : "Participante B (invitado o segunda voz)"}</legend>
              <label>Nombre<input aria-label={`Nombre ${i === 0 ? "A" : "B"}`} value={p.name} maxLength={60} onChange={(e) => setP(i as 0 | 1, { name: e.target.value })} className={input} /></label>
              <label>Rol (opcional)<input aria-label={`Rol ${i === 0 ? "A" : "B"}`} value={p.role} maxLength={120} onChange={(e) => setP(i as 0 | 1, { role: e.target.value })} className={input} /></label>
            </fieldset>
          ))}
        </div>
      )}

      {d.step === 4 && (
        <div className="mt-3 grid gap-3 text-sm">
          {active.map((p, i) => (
            <fieldset key={i} className="rounded border border-border p-2">
              <legend className="px-1">{p.name}</legend>
              <label>Voz
                <select aria-label={`Voz ${i === 0 ? "A" : "B"}`} value={p.voice_id} onChange={(e) => setP(i as 0 | 1, { voice_id: e.target.value })} className={input}>
                  <option value="">Elige una voz…</option>
                  {voices.map((v) => <option key={v.voiceId} value={v.voiceId} disabled={!v.available}>{v.name}{v.note ? ` — ${v.note}` : ""}</option>)}
                </select>
              </label>
              {voices.some((v) => !v.available) && <p className="text-xs text-ink-muted">Las voces marcadas «No disponible» no se pueden usar y nunca se reemplazan por otra.</p>}
              {d.mode !== "narracion" && (
                <div className="mt-2">
                  <span>Avatar</span>
                  <select aria-label={`Avatar ${i === 0 ? "A" : "B"}`} value={p.avatar.kind === "existente" ? p.avatar.avatar_id : p.avatar.kind === "foto" ? "__foto" : ""}
                    onChange={(e) => setP(i as 0 | 1, { avatar: e.target.value === "__foto" ? { kind: "foto", photo_path: "", consent: false, consent_at: null } : e.target.value ? { kind: "existente", avatar_id: e.target.value } : { kind: "ninguno" } })} className={input}>
                    <option value="">Elige…</option>
                    {avatars.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    <option value="__foto">Crear desde una foto</option>
                  </select>
                  {p.avatar.kind === "foto" && (
                    <div className="mt-2 grid gap-1">
                      <input aria-label={`Foto ${i === 0 ? "A" : "B"}`} type="file" accept="image/jpeg,image/png" onChange={(e) => e.target.files?.[0] && uploadPhoto(i as 0 | 1, e.target.files[0])} />
                      {p.avatar.photo_path && <span className="text-xs text-ink-muted">Foto subida.</span>}
                      <label className="text-xs"><input type="checkbox" aria-label={`Consentimiento ${i === 0 ? "A" : "B"}`} checked={p.avatar.consent} onChange={(e) => setP(i as 0 | 1, { avatar: { ...(p.avatar as Extract<typeof p.avatar, { kind: "foto" }>), consent: e.target.checked, consent_at: e.target.checked ? new Date().toISOString() : null } })} /> {CONSENT_TEXT}</label>
                    </div>
                  )}
                </div>
              )}
            </fieldset>
          ))}
        </div>
      )}

      {d.step === 5 && (
        <div className="mt-3 grid gap-3 text-sm">
          <label>Escenario<select aria-label="Escenario" value={d.set} onChange={(e) => set({ set: e.target.value as WizardDraft["set"] })} className={input}>{SETS.map((s) => <option key={s} value={s}>{SET_LABEL[s]}</option>)}</select></label>
          {d.mode === "dialogo" && <label><input type="checkbox" checked={d.swap} onChange={(e) => set({ swap: e.target.checked })} /> Invertir posiciones (anfitrión a la derecha)</label>}
          <label><input type="checkbox" checked={d.subtitles} onChange={(e) => set({ subtitles: e.target.checked })} /> Subtítulos</label>
          <label><input type="checkbox" checked={d.recreations} onChange={(e) => set({ recreations: e.target.checked })} /> Permitir recreaciones (se marcan «Recreación» en pantalla)</label>
          {d.mode !== "narracion" && (<>
            <label>Frecuencia del avatar: {Math.round(d.avatarFrequency * 100)}% de los turnos<input aria-label="Frecuencia del avatar" type="range" min={0.1} max={1} step={0.1} value={d.avatarFrequency} onChange={(e) => set({ avatarFrequency: Number(e.target.value) })} className="w-full" /></label>
            <label>Duración máxima por aparición: {d.avatarMaxSeconds} s<input aria-label="Duración máxima del avatar" type="range" min={5} max={60} step={5} value={d.avatarMaxSeconds} onChange={(e) => set({ avatarMaxSeconds: Number(e.target.value) })} className="w-full" /></label>
            <p className="text-xs text-ink-muted">Menos apariciones = menor costo. Los planos de dos personas se componen: cada avatar se genera por separado.</p>
          </>)}
        </div>
      )}

      {d.step === 6 && (
        <div className="mt-3 grid gap-3 text-sm">
          <label><input type="checkbox" aria-label="Música de fondo" checked={d.musicEnabled} onChange={(e) => set({ musicEnabled: e.target.checked })} /> Música de fondo (biblioteca propia con licencia CC0)</label>
          {d.musicEnabled && (<>
            <label>Ambiente musical<select aria-label="Ambiente musical" value={d.mood} onChange={(e) => set({ mood: e.target.value as WizardDraft["mood"] })} className={input}>
              <option value="auto">Automático según el guion</option>{MOODS.map((m) => <option key={m} value={m}>{MOOD_LABEL[m]}</option>)}</select></label>
            <label>Volumen de la música: {d.volumeDb} dB<input aria-label="Volumen de la música" type="range" min={-34} max={-14} value={d.volumeDb} onChange={(e) => set({ volumeDb: Number(e.target.value) })} className="w-full" /></label>
            <label><input type="checkbox" checked={d.stings} onChange={(e) => set({ stings: e.target.checked })} /> Cortina de entrada y transiciones</label>
            <label>Sonido ambiente<select aria-label="Sonido ambiente" value={d.ambient} onChange={(e) => set({ ambient: e.target.value as WizardDraft["ambient"] })} className={input}>
              <option value="ninguno">Ninguno</option><option value="lluvia">Lluvia</option><option value="viento">Viento</option><option value="noche">Noche</option></select></label>
            <p className="text-xs text-ink-muted">La música baja sola cuando alguien habla. El audio final se ajusta a −16 LUFS.</p>
          </>)}
        </div>
      )}

      {d.step === 7 && (
        <div className="mt-3 grid gap-3 text-sm">
          <div className="flex gap-4" role="radiogroup" aria-label="Formato de video">
            <label><input type="radio" checked={d.format === "16:9"} onChange={() => set({ format: "16:9" })} /> Horizontal 16:9 (YouTube)</label>
            <label><input type="radio" checked={d.format === "9:16"} onChange={() => set({ format: "9:16" })} /> Vertical 9:16 (Reels/TikTok)</label>
          </div>
          <div className="flex gap-4" role="radiogroup" aria-label="Formato de audio">
            <label><input type="radio" checked={d.audioExport === "mp3"} onChange={() => set({ audioExport: "mp3" })} /> Audio MP3</label>
            <label><input type="radio" checked={d.audioExport === "wav"} onChange={() => set({ audioExport: "wav" })} /> Audio WAV</label>
          </div>
        </div>
      )}

      {d.step === 8 && (
        <div className="mt-3 grid gap-2 text-sm" data-testid="wizard-estimate">
          {!estimate ? <Button type="button" variant="secondary" size="sm" onClick={loadEstimate} loading={busy}>Calcular costo</Button> : (
            <>
              <table className="w-full text-left"><tbody>
                {estimate.lines.map((l) => <tr key={l.concept}><td className="pr-2 font-medium capitalize">{l.concept}</td><td className="pr-2 text-ink-muted">{l.detail}</td><td className="text-right">{USD(l.usd)}</td></tr>)}
                <tr><td className="pt-1 font-semibold">Total estimado</td><td /><td className="pt-1 text-right font-semibold">{USD(estimate.totalUsd)}</td></tr>
              </tbody></table>
              <p className="text-xs text-ink-muted">{estimate.turns} turnos · música: {estimate.mood}. Supuestos: {estimate.assumptions.join(" ")}</p>
            </>
          )}
          <label>Presupuesto máximo del episodio (USD)<input aria-label="Presupuesto máximo" type="number" min={0.5} max={500} step={0.5} value={d.budgetUsd} onChange={(e) => set({ budgetUsd: Number(e.target.value) })} className={input} /></label>
          {estimate && estimate.totalUsd > d.budgetUsd && <p className="text-danger">El costo estimado supera tu presupuesto: súbelo o reduce las apariciones del avatar.</p>}
        </div>
      )}

      {d.step === 9 && (
        <div className="mt-3 grid gap-2 text-sm">
          {modeBlocked ? <p className="text-danger">Este modo se activa cuando el propietario autorice la migración y el interruptor del estudio. Puedes volver al paso 1 y elegir «Narración».</p> : (<>
            <p>Se generará «{d.title}» ({MODE_LABEL[d.mode ?? "narracion"]}). Costo estimado: <b>{estimate ? USD(estimate.totalUsd) : "—"}</b>. Nunca se cobrará más de <b>{USD(d.budgetUsd)}</b>.</p>
            <label><input type="checkbox" aria-label="Autorizo el cargo" checked={d.authorized} onChange={(e) => set({ authorized: e.target.checked })} /> Autorizo generar este episodio con un cargo máximo de {USD(d.budgetUsd)}.</label>
            <Button type="button" onClick={authorizeAndGenerate} loading={busy} disabled={!d.authorized || (estimate?.totalUsd ?? 0) > d.budgetUsd}>Generar episodio</Button>
          </>)}
        </div>
      )}

      {d.step === 10 && (
        <div className="mt-3 text-sm" data-testid="wizard-progress">
          <p>{status ? (status.episode.status === "failed" ? "No se pudo terminar. No se te cobra un episodio no entregado." : STAGE[status.episode.progress?.stage ?? ""] ?? "En cola…") : "Iniciando…"}</p>
          <div className="mt-2 h-2 w-full rounded bg-surface"><div className="h-2 rounded bg-accent" style={{ width: `${status?.episode.progress?.pct ?? 2}%` }} /></div>
          {status?.episode.error && <p className="mt-2 text-danger">{status.episode.error}</p>}
          {status?.episode.status === "failed" && <Button type="button" variant="secondary" size="sm" className="mt-2" onClick={() => { set({ step: 9 }); }}>Reintentar (no se cobra dos veces lo ya generado)</Button>}
          <p className="mt-2 text-xs text-ink-muted">Puedes cerrar esta página: el episodio sigue generándose y aparecerá en «Mis episodios».</p>
        </div>
      )}

      {d.step === 11 && status?.video_url && (
        <div className="mt-3"><video data-testid="wizard-player" src={status.video_url} controls className="w-full rounded" /></div>
      )}

      {d.step === 12 && (
        <div className="mt-3 grid gap-2 text-sm">
          {status?.video_url && <a className="text-accent underline" href={status.video_url} data-testid="wizard-download-mp4">Descargar video (MP4)</a>}
          {status?.audio_url && <a className="text-accent underline" href={status.audio_url} data-testid="wizard-download-audio">Descargar solo audio ({d.audioExport.toUpperCase()})</a>}
          {status?.episode.cost_usd != null && <p className="text-ink-muted">Costo registrado: {USD(Number(status.episode.cost_usd))}</p>}
        </div>
      )}

      {d.step === 13 && <p className="mt-3 text-sm">Tus episodios aparecen en la lista de abajo.</p>}

      {note && <p className="mt-3 text-sm text-ink-muted">{note}</p>}
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex justify-between">
        <Button type="button" variant="ghost" size="sm" onClick={() => go(Math.max(0, d.step - 1))} disabled={d.step === 0 || busy || d.step === 10}>Atrás</Button>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => { localStorage.removeItem(WIZARD_STORAGE_KEY); setD(defaultDraft()); setEstimate(null); setStatus(null); setNote(null); setError(null); router.refresh(); }}>Empezar de nuevo</Button>
          {d.step < 9 && <Button type="button" size="sm" onClick={next} disabled={busy}>Siguiente</Button>}
          {d.step >= 11 && d.step < 13 && <Button type="button" size="sm" onClick={() => go(d.step + 1)}>Siguiente</Button>}
        </div>
      </div>
    </Card>
  );
}
