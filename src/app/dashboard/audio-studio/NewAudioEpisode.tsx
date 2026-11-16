"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { INPUT_CLASS } from "@/components/ui/Field";
import { LANGUAGES, MAX_TITLE, type Language } from "@/lib/audio-studio/model";

export function NewAudioEpisode() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [voiceCount, setVoiceCount] = useState<1 | 2>(1);
  const [language, setLanguage] = useState<Language>("es");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/audio-studio/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, voiceCount, language }) });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.id) throw new Error(body?.error ?? "No se pudo crear el episodio.");
      router.push(`/dashboard/audio-studio/${body.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo crear el episodio.");
      setBusy(false);
    }
  }

  return (
    <Card className="p-4">
      <form onSubmit={create} className="space-y-3" data-testid="audio-new">
        <h2 className="text-base font-semibold text-ink">Nuevo episodio</h2>
        <label htmlFor="audio-new-title" className="block text-sm font-medium text-ink">Título</label>
        <input id="audio-new-title" className={INPUT_CLASS} value={title} maxLength={MAX_TITLE} onChange={(e) => setTitle(e.target.value)} placeholder="¿De qué trata el episodio?" required />
        <fieldset className="flex flex-wrap gap-2">
          <legend className="mb-1 text-sm font-medium text-ink">Voces</legend>
          {([1, 2] as const).map((n) => (
            <label key={n} className={`inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm ${voiceCount === n ? "border-accent bg-accent-soft text-ink" : "border-border-strong text-ink-muted"}`}>
              <input type="radio" name="voiceCount" value={n} checked={voiceCount === n} onChange={() => setVoiceCount(n)} />
              {n === 1 ? "Una voz" : "Dos voces"}
            </label>
          ))}
        </fieldset>
        <label htmlFor="audio-new-language" className="block text-sm font-medium text-ink">Idioma</label>
        <select id="audio-new-language" data-testid="audio-new-language" className={INPUT_CLASS} value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
          {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
        </select>
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <Button type="submit" loading={busy} disabled={busy || !title.trim()} className="min-h-11">Crear episodio</Button>
      </form>
    </Card>
  );
}
