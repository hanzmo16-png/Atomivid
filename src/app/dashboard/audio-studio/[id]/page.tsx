import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { audioStudioUser, studioDeps } from "@/lib/audio-studio/server";
import { readProject } from "@/lib/audio-studio/service";
import { AudioEditor } from "../AudioEditor";
import { scriptAiAvailability } from "@/lib/audio-studio/script-llm";

export const metadata: Metadata = { title: "Editor · Audio Podcast Studio" };
export const dynamic = "force-dynamic";

export default async function AudioProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await audioStudioUser();
  if ("error" in user) {
    if (user.status === 401) redirect("/login");
    notFound();
  }
  // Solo lectura: el episodio inicial aún no guardado se abre virtual (sin escribir nada).
  const out = await readProject(studioDeps(user), user.id, (await params).id, { owner: user.owner });
  if (!out.ok) notFound();
  const ai = scriptAiAvailability(user.id);
  return (
    <div className="space-y-4">
      <Link href="/dashboard/audio-studio" className="inline-flex min-h-11 items-center text-sm text-ink-muted hover:text-ink">← Biblioteca de audio</Link>
      <AudioEditor initial={out.body} scriptAi={ai.mode === "off" ? { available: false, reason: ai.reason } : { available: true }} />
    </div>
  );
}
