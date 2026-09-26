/**
 * Red de seguridad de voice-clone.yml: si el worker se corta, la voz queda
 * «failed» en vez de colgada. Si se cortó durante la clonación, pudo
 * crearse la voz en el proveedor: queda en revisión (needs_review) y no se
 * reintenta sola.
 *
 * Uso: VOICE_ID=<uuid> npx tsx scripts/mark-voice-clone-failed.ts
 */
export {};

async function main() {
  const voiceId = process.env.VOICE_ID;
  if (!voiceId) return;
  const { readFile } = await import("node:fs/promises");
  const saved = await readFile(".voice-clone.json", "utf8").then(JSON.parse).catch(() => null);
  if (!saved || saved.voiceId !== voiceId) return;
  const { createServiceClient } = await import("../src/lib/supabase/service");
  const service = createServiceClient();
  const now = new Date().toISOString();
  await service
    .from("user_voices")
    .update({ status: "failed", needs_review: true, error_message: "La clonación se interrumpió y pudo haber creado la voz. La revisaremos.", updated_at: now })
    .eq("id", voiceId)
    .eq("status", "cloning");
  await service
    .from("user_voices")
    .update({ status: "failed", error_message: "La prueba de tu voz no terminó a tiempo. Puedes reintentar.", updated_at: now })
    .eq("id", voiceId)
    .eq("status", "testing");
}

main().catch(() => {
  console.error("VOICE_CLONE_CLEANUP_FAILED");
  process.exit(1);
});
