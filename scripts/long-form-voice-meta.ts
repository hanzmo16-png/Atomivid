/** Read-only ElevenLabs metadata GET (no synthesis, no charge) for the Thermopylae voice. Prints labels only. */
export {};
const id = "cCYjmrGZaI86GUJ7F2Nn";
async function main() {
  const key = process.env.ELEVENLABS_API_KEY?.trim(); if (!key) throw Error("no key");
  const r = await fetch(`https://api.elevenlabs.io/v1/voices/${id}`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(20_000) });
  const v = await r.json() as any;
  console.log("DIAG_VOICE_META", JSON.stringify({ status: r.status, name: v.name, category: v.category, labels: v.labels, preview: !!v.preview_url,
    fineTuning: v.fine_tuning ? Object.keys(v.fine_tuning.state ?? {}) : null, sharing: v.sharing?.status ?? null, verifiedLangs: (v.verified_languages ?? []).map((l: any) => l.language).slice(0, 6),
    isWorkerDefault: process.env.ELEVENLABS_VOICE_ID?.trim() === id, workerDefaultSet: !!process.env.ELEVENLABS_VOICE_ID?.trim() }));
}
main().catch(e => { console.error("FAILED", String(e).slice(0, 200)); process.exitCode = 1; });
