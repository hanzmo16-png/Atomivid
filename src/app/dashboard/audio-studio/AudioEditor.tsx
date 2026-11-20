"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { INPUT_CLASS } from "@/components/ui/Field";
import { commitTargetMinutes, parseTargetMinutes, voiceReplacements } from "@/lib/audio-studio/editor-rules";
import {
  LANGUAGES, defaultSecondVoice, draftOutline, estimate, GENERATION_LABEL, generationActive, MAX_BUDGET_USD, MAX_SCRIPT, MAX_TARGET_MINUTES, MAX_TITLE, MIN_TARGET_MINUTES, MOOD_LABEL, MUSIC_MOODS,
  audioProviderNote, DEMO_VOICE_LABEL, FALLBACK_TTS_MODEL, musicPlan, readinessIssues, STATUS_LABEL, TTS_MODELS, ttsModel, VOICE_PRESETS, voicePreset, type StudioLanguage, type AudioProject, type MusicConfig, type MusicMood, type TtsModelId,
} from "@/lib/audio-studio/model";
import type { StudioCatalogVoice } from "@/lib/audio-studio/catalog";
import type { ProjectView } from "@/lib/audio-studio/service";

type Draft = Pick<AudioProject, "title" | "language" | "voiceCount" | "voices" | "targetMinutes" | "script" | "notes" | "music" | "budgetUsd" | "ttsModel">;
const draftOf = (p: AudioProject): Draft => ({ title: p.title, language: p.language, voiceCount: p.voiceCount, voices: [...p.voices], targetMinutes: p.targetMinutes, script: p.script, notes: p.notes, music: { ...p.music }, budgetUsd: p.budgetUsd, ttsModel: p.ttsModel });
const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);
const usd = (n: number) => `USD ${n.toFixed(2)}`;
const AUTOSAVE_MS = 2500;

/**
 * Estado de la síntesis según el servidor: "real" (ElevenLabs), "local" (voz de prueba), "demo" (voz de demostración,
 * solo la cuenta dueña, USD 0) o "inactiva".
 */
export type Synthesis = "real" | "local" | "demo" | "inactiva";

export function AudioEditor({ initial, synthesis: initialSynthesis = null }: { initial: ProjectView; synthesis?: Synthesis | null }) {
  const [saved, setSaved] = useState<ProjectView>(initial);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [state, setState] = useState<"idle" | "saving" | "error" | "conflict">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "listo" | "generar" | "archivar" | "restaurar" | "remezclar" | "reanudar" | "respaldo">(null);
  const [catalog, setCatalog] = useState<StudioCatalogVoice[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReload, setCatalogReload] = useState(0);
  const [synthesis, setSynthesis] = useState<Synthesis | null>(initialSynthesis);
  useEffect(() => {
    let alive = true;
    fetch("/api/audio-studio/voices", { cache: "no-store" }).then(async res => {
      const body = await res.json();
      if (alive && (body.synthesis === "real" || body.synthesis === "local" || body.synthesis === "demo" || body.synthesis === "inactiva")) setSynthesis(body.synthesis);
      if (!res.ok) throw new Error(body.error ?? "No se pudieron cargar las voces.");
      if (alive) { setCatalog(body.voices); setCatalogError(null); }
    }).catch(err => { if (alive) setCatalogError(err.message); });
    return () => { alive = false; };
  }, [catalogReload]);
  // Consentimiento ligado al contenido exacto que se autoriza (guion, voces, duración, modelo, tope): cualquier cambio lo invalida.
  const [authorizedFor, setAuthorizedFor] = useState<string | null>(null);
  // Texto libre del campo de duración: se puede borrar y reescribir; se valida al salir del campo.
  const [targetText, setTargetText] = useState<string | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const dirty = !same(draft, draftOf(saved));
  const archived = !!saved.archivedAt;
  const g = saved.generation;
  const running = generationActive(g, clock);
  const locked = archived || running;
  const savingRef = useRef(false);

  // Tarifa del modelo elegido en el borrador (el servidor manda la de cada modelo; nunca se asume un descuento).
  const modelRateInfo = saved.rates?.find((r) => r.model === draft.ttsModel) ?? saved.rate;
  const rate = modelRateInfo?.rate ?? saved.estimate.voiceUsdPer1kChars;
  const live = useMemo(() => estimate({ ...draft, spentUsd: saved.spentUsd }, rate), [draft, saved.spentUsd, rate]);
  const plan = useMemo(() => musicPlan(draft.script, draft.music), [draft.script, draft.music]);
  const issues = useMemo(() => readinessIssues({ ...saved, ...draft }, live), [saved, draft, live]);

  const save = useCallback(async (): Promise<ProjectView | null> => {
    if (savingRef.current) return null;
    savingRef.current = true;
    setState("saving"); setMessage(null);
    try {
      const res = await fetch(`/api/audio-studio/projects/${saved.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: saved.revision, ...draft }) });
      const body = await res.json().catch(() => null);
      if (res.status === 409) { setState("conflict"); setMessage(body?.error ?? "El proyecto cambió en otro lugar."); return null; }
      if (!res.ok) { setState("error"); setMessage(body?.error ?? "No se pudo guardar."); return null; }
      setSaved(body); setState("idle");
      return body as ProjectView;
    } catch {
      setState("error"); setMessage("Sin conexión: los cambios siguen en esta pantalla. Vuelve a intentar.");
      return null;
    } finally { savingRef.current = false; }
  }, [draft, saved.id, saved.revision]);

  // Guardado automático tras una pausa al escribir.
  useEffect(() => {
    if (!dirty || locked || state === "conflict" || state === "saving") return;
    const t = setTimeout(() => { void save(); }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [dirty, locked, state, save]);

  // Mientras se genera: consulta el estado cada 3 s (el editor queda bloqueado hasta que termine).
  useEffect(() => {
    if (g.status !== "en_cola" && g.status !== "generando") return;
    // «alive»: una respuesta que llega después de terminar la consulta se descarta; si no, podía pisar lo que la
    // persona empezó a escribir al terminar la generación (el editor perdía el cambio y «Guardar» quedaba inactivo).
    let alive = true;
    const t = setInterval(async () => {
      setClock(Date.now());
      const res = await fetch(`/api/audio-studio/projects/${saved.id}`, { cache: "no-store" }).catch(() => null);
      if (!alive || !res?.ok) return;
      const body = await res.json().catch(() => null);
      if (!alive || !body) return;
      setSaved(body);
      if (body.generation.status !== "en_cola" && body.generation.status !== "generando") setDraft(draftOf(body));
    }, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [g.status, saved.id]);

  // Aviso del navegador si se cierra con cambios sin guardar.
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  // Cerrojo síncrono: `busy` es estado de React y no bloquea un segundo clic en el mismo instante (doble toque).
  const actionRef = useRef(false);
  async function action(a: "listo" | "generar" | "archivar" | "restaurar" | "remezclar" | "reanudar" | "respaldo") {
    if (actionRef.current) return;
    actionRef.current = true;
    setBusy(a); setMessage(null);
    try {
      let current = saved;
      if (dirty && a !== "restaurar" && a !== "reanudar") { const s = await save(); if (!s) return; current = s; }
      const payload: Record<string, unknown> = { action: a, revision: current.revision };
      if (a === "generar") payload.confirmUsd = current.estimate.estimatedUsd;
      const res = await fetch(`/api/audio-studio/projects/${saved.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await res.json().catch(() => null);
      if (res.ok) { setSaved(body); setDraft(draftOf(body)); setClock(Date.now()); if (a === "generar") setAuthorizedFor(null); }
      else setMessage(body?.error ?? "No se pudo completar la acción.");
    } catch { setMessage("Sin conexión. Vuelve a intentar."); }
    finally { setBusy(null); actionRef.current = false; }
  }

  async function reload() {
    const res = await fetch(`/api/audio-studio/projects/${saved.id}`, { cache: "no-store" });
    if (!res.ok) return;
    const body = await res.json();
    setSaved(body); setDraft(draftOf(body)); setState("idle"); setMessage(null);
  }

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setMusic = <K extends keyof MusicConfig>(k: K, v: MusicConfig[K]) => setDraft((d) => ({ ...d, music: { ...d.music, [k]: v } }));
  const setVoiceCount = (n: 1 | 2) => setDraft((d) => ({ ...d, voiceCount: n, voices: n === 1 ? [d.voices[0]] : [d.voices[0], d.voices[1] ?? defaultSecondVoice(d.voices[0], d.language)] }));
  const setVoice = (i: number, id: string) => setDraft((d) => { const v = [...d.voices]; v[i] = id; return { ...d, voices: v }; });

  const setLanguage = (language: StudioLanguage) => setDraft(d => {
    const voices = VOICE_PRESETS.filter(v => v.language === language);
    return { ...d, language, voices: d.language === language ? d.voices : [voices[0].id, defaultSecondVoice(voices[0].id, language)].slice(0, d.voiceCount) };
  });
  const available = (id: string) => catalog?.find(v => v.id === id)?.models.includes(draft.ttsModel) ?? false;
  const catalogReady = catalog !== null && draft.voices.every(available);
  // Voces elegidas que el catálogo real no ofrece con el modelo actual (bloquean «Generar» aunque el monto esté autorizado).
  const unavailableVoices = catalog === null ? [] : draft.voices.filter((id) => !available(id));
  const replacementVoices = catalog === null ? null : voiceReplacements(draft.voices, draft.language, available);
  const consentKey = JSON.stringify(draft);
  const authorized = authorizedFor === consentKey;
  const commitTarget = (raw: string) => { setTargetText(null); set("targetMinutes", commitTargetMinutes(raw, draft.targetMinutes, MIN_TARGET_MINUTES, MAX_TARGET_MINUTES)); };
  // Sin síntesis real ni local no se ofrece gasto ni generación. Hasta conocer el estado, tampoco.
  const inactive = synthesis === "inactiva";
  const canPay = synthesis === "real" || synthesis === "local" || synthesis === "demo";
  const demo = synthesis === "demo";
  const checkVoices = catalog !== null && !inactive;

  const saveLabel = state === "saving" ? "Guardando…" : state === "conflict" ? "Conflicto de versiones" : state === "error" ? "No guardado" : dirty ? "Cambios sin guardar" : "Guardado";

  return (
    <div className="space-y-4" data-testid="audio-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={saved.status === "listo_para_autorizar" ? "success" : "neutral"}>{STATUS_LABEL[saved.status]}</Badge>
          {archived && <Badge tone="warning">Archivado</Badge>}
          <span className="text-xs text-ink-muted" data-testid="audio-save-state" aria-live="polite">{saveLabel}</span>
        </div>
        <Button onClick={() => void save()} disabled={!dirty || locked || state === "saving" || state === "conflict"} className="min-h-11" data-testid="audio-save">Guardar</Button>
      </div>
      {message && (
        <div role="alert" className="rounded-md border border-border-strong bg-surface-raised p-3 text-sm text-ink" data-testid="audio-message">
          {message} {state === "conflict" && <button type="button" onClick={() => void reload()} className="ml-1 min-h-11 underline">Cargar la última versión</button>}
        </div>
      )}

      <Card className="space-y-4 p-4">
        <div>
          <label htmlFor="audio-title" className="mb-1.5 block text-sm font-medium text-ink">Título</label>
          <input id="audio-title" data-testid="audio-title" className={INPUT_CLASS} value={draft.title} maxLength={MAX_TITLE} disabled={locked} onChange={(e) => set("title", e.target.value)} />
        </div>
        <div>
          <label htmlFor="audio-language" className="mb-1.5 block text-sm font-medium text-ink">Idioma del episodio</label>
          <select id="audio-language" data-testid="audio-language" className={INPUT_CLASS} value={draft.language} disabled={locked} onChange={e => setLanguage(e.target.value as StudioLanguage)}>
            {LANGUAGES.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
          <p className="mt-1 text-xs text-ink-muted">Escribe o pega el guion en el idioma elegido. Cambiar el idioma no traduce el texto.</p>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-ink">Voces</legend>
          <div className="flex flex-wrap gap-2">
            {([1, 2] as const).map((n) => (
              <label key={n} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm ${draft.voiceCount === n ? "border-accent bg-accent-soft text-ink" : "border-border-strong text-ink-muted"}`}>
                <input type="radio" name="voiceCount" data-testid={`audio-voices-${n}`} checked={draft.voiceCount === n} disabled={locked} onChange={() => setVoiceCount(n)} />
                {n === 1 ? "Una voz" : "Dos voces"}
              </label>
            ))}
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {draft.voices.slice(0, draft.voiceCount).map((v, i) => (
              <div key={i}>
                <label htmlFor={`audio-voice-${i}`} className="mb-1 block text-xs text-ink-muted">{draft.voiceCount === 1 ? "Voz" : `Voz ${i + 1}`}</label>
                <select id={`audio-voice-${i}`} data-testid={`audio-voice-${i}`} className={INPUT_CLASS} value={v} disabled={locked} onChange={(e) => setVoice(i, e.target.value)}>
                  {VOICE_PRESETS.filter(p => p.language === draft.language).map((p) => <option key={p.id} value={p.id} disabled={checkVoices && !available(p.id)}>{p.label} — {p.gender}{checkVoices && !available(p.id) ? " (no disponible con este modelo)" : ""}</option>)}
                </select>
                <p className="mt-1 text-xs text-ink-faint">{voicePreset(v)?.accent} · {voicePreset(v)?.style}</p>
                {catalog?.find(c => c.id === v)?.previewUrl && <div className="mt-2"><span className="text-xs text-ink-muted">Muestra de la voz (catálogo de ElevenLabs)</span><audio aria-label={`Muestra de ${voicePreset(v)?.label}`} controls preload="none" className="mt-1 w-full" src={catalog.find(c => c.id === v)!.previewUrl!} /></div>}
              </div>
            ))}
          </div>
          {catalogError && <p role="alert" className="mt-2 text-sm text-danger">{catalogError} <button type="button" className="underline" onClick={() => setCatalogReload(n => n + 1)}>Reintentar</button></p>}
          {!catalog && !catalogError && <p className="mt-2 text-xs text-ink-muted">Comprobando voces disponibles…</p>}
          {checkVoices && !catalogReady && <p className="mt-2 text-sm text-danger">Elige voces disponibles para este modelo antes de generar.</p>}
          {draft.voiceCount === 2 && <p className="mt-2 text-xs text-ink-muted">En el guion, empieza cada intervención con «Voz 1:» o «Voz 2:» (en inglés también «Voice 1:» / «Voice 2:»).</p>}
          <div className="mt-3">
            <label htmlFor="audio-model" className="mb-1 block text-xs text-ink-muted">Modelo de voz</label>
            <select id="audio-model" data-testid="audio-model" className={INPUT_CLASS} value={draft.ttsModel} disabled={locked} onChange={(e) => set("ttsModel", e.target.value as TtsModelId)}>
              {TTS_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
            <p className="mt-1 text-xs text-ink-faint" data-testid="audio-model-note">
              {ttsModel(draft.ttsModel)?.description}{ttsModel(draft.ttsModel)?.verified ? "" : " Se envían solo los ajustes comprobados (estabilidad y similitud)."}
            </p>
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="audio-target" className="mb-1.5 block text-sm font-medium text-ink">Duración objetivo (min)</label>
            <input id="audio-target" data-testid="audio-target" type="text" inputMode="numeric" pattern="[0-9]*" min={MIN_TARGET_MINUTES} max={MAX_TARGET_MINUTES} className={INPUT_CLASS} value={targetText ?? String(draft.targetMinutes)} disabled={locked}
              onChange={(e) => { const t = e.target.value.replace(/[^0-9]/g, "").slice(0, 3); setTargetText(t); const n = parseTargetMinutes(t, MIN_TARGET_MINUTES, MAX_TARGET_MINUTES); if (n !== null) set("targetMinutes", n); }}
              onBlur={(e) => commitTarget(e.target.value)} />
          </div>
          <div>
            <label htmlFor="audio-budget" className="mb-1.5 block text-sm font-medium text-ink">Tope de gasto del episodio (USD)</label>
            <input id="audio-budget" data-testid="audio-budget" type="number" inputMode="decimal" min={0.5} max={MAX_BUDGET_USD} step={0.5} className={INPUT_CLASS} value={draft.budgetUsd} disabled={locked}
              onChange={(e) => set("budgetUsd", Math.min(MAX_BUDGET_USD, Math.max(0.5, Number(e.target.value) || 0.5)))} />
          </div>
        </div>
      </Card>

      <Card className="space-y-2 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <label htmlFor="audio-script" className="text-sm font-medium text-ink">Guion</label>
          <span className="text-xs text-ink-muted" data-testid="audio-script-stats">{live.words.toLocaleString("es")} palabras · {live.characters.toLocaleString("es")} caracteres · ≈ {live.estimatedMinutes} min</span>
        </div>
        <p className="text-xs text-ink-faint">Las líneas que empiezan con «## » son títulos de sección: organizan la música y no se narran.</p>
        {!draft.script.trim() && !locked && (
          <Button type="button" variant="secondary" className="min-h-11" data-testid="audio-outline" onClick={() => set("script", draftOutline(draft.title, draft.targetMinutes, draft.voiceCount, draft.language))}>
            Generar estructura de guion
          </Button>
        )}
        <textarea id="audio-script" data-testid="audio-script" className={`${INPUT_CLASS} min-h-[50vh] font-mono leading-relaxed`} value={draft.script} maxLength={MAX_SCRIPT} disabled={locked} onChange={(e) => set("script", e.target.value)} />
        <label htmlFor="audio-notes" className="block text-sm font-medium text-ink">Notas de dirección</label>
        <textarea id="audio-notes" data-testid="audio-notes" className={`${INPUT_CLASS} min-h-24`} value={draft.notes} maxLength={2000} disabled={locked} onChange={(e) => set("notes", e.target.value)} />
      </Card>

      <Card className="space-y-3 p-4" data-testid="audio-music">
        <h2 className="text-base font-semibold text-ink">Música de fondo</h2>
        <div className="flex flex-wrap gap-2">
          {([["inteligente", "Inteligente"], ["fija", "Un solo ambiente"], ["sin_musica", "Sin música"]] as const).map(([m, label]) => (
            <label key={m} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm ${draft.music.mode === m ? "border-accent bg-accent-soft text-ink" : "border-border-strong text-ink-muted"}`}>
              <input type="radio" name="musicMode" data-testid={`audio-music-${m}`} checked={draft.music.mode === m} disabled={locked} onChange={() => setMusic("mode", m)} />
              {label}
            </label>
          ))}
        </div>
        {draft.music.mode !== "sin_musica" && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="audio-mood" className="mb-1 block text-xs text-ink-muted">{draft.music.mode === "inteligente" ? "Ambiente base (cuando una sección no marca otro)" : "Ambiente"}</label>
                <select id="audio-mood" data-testid="audio-mood" className={INPUT_CLASS} value={draft.music.mood} disabled={locked} onChange={(e) => setMusic("mood", e.target.value as MusicMood)}>
                  {MUSIC_MOODS.map((m) => <option key={m} value={m}>{MOOD_LABEL[m]}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="audio-volume" className="mb-1 block text-xs text-ink-muted">Volumen bajo la voz: {draft.music.volume} %</label>
                <input id="audio-volume" data-testid="audio-volume" type="range" min={0} max={60} className="h-11 w-full" value={draft.music.volume} disabled={locked} onChange={(e) => setMusic("volume", Number(e.target.value))} />
              </div>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink">
              {([["ducking", "Bajar la música cuando hay voz"], ["intro", "Entrada musical"], ["outro", "Cierre musical"]] as const).map(([k, label]) => (
                <label key={k} className="inline-flex min-h-11 items-center gap-2">
                  <input type="checkbox" data-testid={`audio-music-${k}`} checked={draft.music[k]} disabled={locked} onChange={(e) => setMusic(k, e.target.checked)} /> {label}
                </label>
              ))}
            </div>
            {plan.length > 0 && (
              <details className="text-sm" data-testid="audio-music-plan">
                <summary className="min-h-11 cursor-pointer py-2 text-ink-muted">Plan musical por sección ({plan.length})</summary>
                <ol className="mt-1 space-y-1 text-xs text-ink-muted">
                  {plan.map((s) => <li key={s.index}>{s.index + 1}. {s.heading}: <span className="text-ink">{MOOD_LABEL[s.mood]}</span></li>)}
                </ol>
              </details>
            )}
            <p className="text-xs text-ink-faint">Música de la biblioteca propia de Atomivid (CC0). No usa proveedores de pago.</p>
          </>
        )}
      </Card>

      <Card className="space-y-2 p-4" data-testid="audio-budget-panel">
        <h2 className="text-base font-semibold text-ink">Presupuesto</h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt className="text-ink-muted">Costo estimado de voz</dt><dd className="text-right text-ink" data-testid="audio-estimated-usd">{usd(live.estimatedUsd)}</dd>
          <dt className="text-ink-muted">Tope del episodio</dt><dd className="text-right text-ink">{usd(draft.budgetUsd)}</dd>
          <dt className="text-ink-muted">Gastado</dt><dd className="text-right text-ink" data-testid="audio-spent-usd">{usd(saved.spentUsd)}</dd>
          <dt className="text-ink-muted">Tarifa usada</dt><dd className="text-right text-ink-muted" data-testid="audio-rate">USD {rate.toFixed(2)} / 1 000 caracteres</dd>
        </dl>
        {modelRateInfo && <p className="text-xs text-ink-muted" data-testid="audio-rate-note">{modelRateInfo.note}</p>}
        {!live.withinBudget && <p className="text-sm text-danger">El costo estimado supera el tope.</p>}
        <p className="text-xs text-ink-faint">Mientras editas no se hace ninguna llamada de pago. La música es propia y gratuita.</p>
      </Card>

      <Card className="space-y-3 p-4" data-testid="audio-production">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold text-ink">Producción</h2>
          <Badge tone={g.status === "terminada" ? "success" : g.status === "fallida" ? "danger" : running ? "info" : "neutral"}>
            <span data-testid="audio-generation-status">{running || g.status !== "generando" ? GENERATION_LABEL[g.status] : "Interrumpida"}</span>
          </Badge>
        </div>
        {inactive && (
          <p role="status" className="rounded-md border border-border bg-surface-raised p-3 text-sm text-ink" data-testid="audio-voice-disabled">
            La generación de audio con voz todavía no está activada. Puedes escribir, guardar, archivar y restaurar el episodio; no se puede generar el MP3 y no se hará ningún cargo.
          </p>
        )}
        {demo && (
          <p role="status" className="rounded-md border border-warning bg-surface-raised p-3 text-sm font-medium text-ink" data-testid="audio-voice-demo">
            {DEMO_VOICE_LABEL}. El MP3 se genera con una voz sintética gratuita (espeak-ng) para escuchar y descargar el episodio completo; no se llama a ElevenLabs ni se hace ningún cargo.
          </p>
        )}
        {synthesis === "local" && (
          <p className="text-xs text-ink-muted" data-testid="audio-voice-local">Voz de prueba local: el MP3 se genera con una voz sintética de prueba, no con la voz final. Sin costo.</p>
        )}
        {issues.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-muted" data-testid="audio-readiness">{issues.map((i) => <li key={i}>{i}</li>)}</ul>
        ) : (
          <p className="text-sm text-ink-muted" data-testid="audio-readiness-ok">El guion, las voces, la música y el presupuesto están completos.</p>
        )}
        {running && g.progress && (
          <div data-testid="audio-progress">
            <div className="h-2 w-full overflow-hidden rounded bg-surface-raised" role="progressbar" aria-valuemin={0} aria-valuemax={g.progress.total} aria-valuenow={g.progress.done}>
              <div className="h-2 bg-accent" style={{ width: `${Math.round((g.progress.done / Math.max(1, g.progress.total)) * 100)}%` }} />
            </div>
            <p className="mt-1 text-xs text-ink-muted">{g.progress.done} de {g.progress.total} intervenciones con voz · luego mezcla y máster</p>
          </div>
        )}
        {g.error && !running && <p role="alert" className="text-sm text-danger" data-testid="audio-generation-error">{g.error}</p>}
        {saved.audio && (
          <div className="space-y-2 rounded-md border border-border p-3" data-testid="audio-result">
            <audio controls preload="none" className="w-full" src={`/api/audio-studio/projects/${saved.id}/audio`} data-testid="audio-player" />
            <p className="text-xs text-ink-muted">
              {Math.floor(saved.audio.durationSeconds / 60)} min {Math.round(saved.audio.durationSeconds % 60)} s · {saved.audio.lufs} LUFS · pico {saved.audio.truePeak} dBTP · {(saved.audio.bytes / 1e6).toFixed(1)} MB
              {audioProviderNote(saved.audio.provider)}{saved.audio.revision !== saved.revision ? " · de una versión anterior del guion" : ""}
            </p>
            <a href={`/api/audio-studio/projects/${saved.id}/audio?descargar=1`} className="inline-flex min-h-11 items-center text-sm font-medium text-accent underline" data-testid="audio-download">Descargar MP3</a>
          </div>
        )}
        {canPay && !archived && !running && g.status !== "fallida" && (
          <label className="flex min-h-11 items-start gap-2 text-sm text-ink">
            <input type="checkbox" className="mt-1" data-testid="audio-authorize" checked={authorized} disabled={issues.length > 0 || !!busy} onChange={(e) => setAuthorizedFor(e.target.checked ? consentKey : null)} />
            {demo ? (
              <span>Confirmo generar con la voz de demostración por <strong data-testid="audio-authorize-usd">USD {live.estimatedUsd.toFixed(2)}</strong> (no es la voz final).</span>
            ) : (
              <span>Autorizo un gasto de hasta <strong data-testid="audio-authorize-usd">USD {live.estimatedUsd.toFixed(2)}</strong> en voz para generar este episodio (tope del episodio USD {draft.budgetUsd.toFixed(2)}).</span>
            )}
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          {!locked && saved.status !== "listo_para_autorizar" && (
            <Button variant="secondary" className="min-h-11" data-testid="audio-ready" disabled={issues.length > 0 || !!busy} loading={busy === "listo"} onClick={() => void action("listo")}>Marcar listo para autorizar</Button>
          )}
          {canPay && !archived && !running && g.status !== "fallida" && (
            <Button className="min-h-11" data-testid="audio-generate" disabled={!authorized || !catalogReady || issues.length > 0 || !!busy} loading={busy === "generar"} onClick={() => void action("generar")}>{demo ? "Generar MP3 de demostración" : "Generar MP3"}</Button>
          )}
          {canPay && !archived && !running && g.status !== "fallida" && !busy && (issues.length > 0 || !authorized || !catalogReady) && (
            <p role="status" className="w-full text-sm text-ink-muted" data-testid="audio-generate-why">
              {issues.length > 0 ? `No se puede generar todavía: ${issues[0]}`
                : catalog === null ? (catalogError ? "No se pudo cargar el catálogo de voces: pulsa «Reintentar» junto a las voces." : "Cargando el catálogo de voces…")
                : !catalogReady ? `No se puede generar: ${unavailableVoices.map((id) => VOICE_PRESETS.find((p) => p.id === id)?.label ?? id).join(" y ")} no ${unavailableVoices.length > 1 ? "están disponibles" : "está disponible"} con el modelo ${TTS_MODELS.find((m) => m.id === draft.ttsModel)?.label ?? draft.ttsModel}. ${replacementVoices ? "Cámbiala por una voz disponible:" : "Elige otro modelo de voz arriba."}`
                : "Marca la autorización del monto para habilitar «Generar»."}
              {catalog === null && catalogError && <> <button type="button" className="underline" data-testid="audio-generate-retry" onClick={() => setCatalogReload((n) => n + 1)}>Reintentar</button></>}
              {catalog !== null && !catalogReady && replacementVoices && <> <button type="button" className="underline" data-testid="audio-generate-fix-voices" onClick={() => set("voices", replacementVoices)}>Usar {replacementVoices.filter((id, i) => id !== draft.voices[i]).map((id) => VOICE_PRESETS.find((p) => p.id === id)?.label ?? id).join(" y ")}</button></>}
            </p>
          )}
          {canPay && !archived && !running && (g.status === "fallida" || g.status === "generando" || g.status === "en_cola") && (
            <Button className="min-h-11" data-testid="audio-resume" disabled={!!busy} loading={busy === "reanudar"} onClick={() => void action("reanudar")}>Reanudar</Button>
          )}
          {!archived && !running && g.status === "fallida" && saved.ttsModel !== FALLBACK_TTS_MODEL && (
            <Button variant="secondary" className="min-h-11" data-testid="audio-fallback" disabled={!!busy} loading={busy === "respaldo"} onClick={() => void action("respaldo")}>
              Cambiar a {ttsModel(FALLBACK_TTS_MODEL)!.label.split(" (")[0]} (respaldo)
            </Button>
          )}
          {!archived && !running && saved.audio && (
            <Button variant="secondary" className="min-h-11" data-testid="audio-remix" disabled={!!busy} loading={busy === "remezclar"} onClick={() => void action("remezclar")}>Remezclar música (sin costo)</Button>
          )}
          {archived ? (
            <Button variant="ghost" className="min-h-11" data-testid="audio-restore" disabled={!!busy} onClick={() => void action("restaurar")}>Restaurar</Button>
          ) : (
            <Button variant="ghost" className="min-h-11" data-testid="audio-archive" disabled={!!busy || running} onClick={() => void action("archivar")}>Archivar</Button>
          )}
        </div>
        <p className="text-xs text-ink-faint">
          Generar necesita tu autorización expresa del monto. La remezcla reutiliza la voz ya generada: no se vuelve a cobrar. Si el proveedor de voz de pago no está habilitado, no se hace ninguna llamada ni cargo.
        </p>
      </Card>
    </div>
  );
}
