import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { audioStudioUser, studioDeps } from "@/lib/audio-studio/server";
import { getProject } from "@/lib/audio-studio/service";
import { AudioEditor } from "../AudioEditor";

export const metadata: Metadata = { title: "Editor · Audio Podcast Studio" };
export const dynamic = "force-dynamic";

export default async function AudioProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await audioStudioUser();
  if ("error" in user) {
    if (user.status === 401) redirect("/login");
    notFound();
  }
  const out = await getProject(studioDeps(), user.id, (await params).id);
  if (!out.ok) notFound();
  return (
    <div className="space-y-4">
      <Link href="/dashboard/audio-studio" className="inline-flex min-h-11 items-center text-sm text-ink-muted hover:text-ink">← Biblioteca de audio</Link>
      <AudioEditor initial={out.body} />
    </div>
  );
}
