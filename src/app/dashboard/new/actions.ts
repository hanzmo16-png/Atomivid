"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { canPrepareAvatar } from "@/lib/video/avatar/private-access";
import { validateCommonFields } from "./validation";

export async function createVideoRequest(formData: FormData) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const mode = String(formData.get("mode") ?? "visual");
  // The old avatar form must never create provider assets during preparation.
  // Reuse the owner-only validated photo + original-audio preparation route.
  if (mode === "avatar" && canPrepareAvatar(user)) redirect("/dashboard/avatar/prepare");
  if (mode !== "visual") redirect("/dashboard/new?error=Tipo+de+video+no+disponible");
  const topic = String(formData.get("topic") ?? "").trim();
  const style = String(formData.get("style") ?? "").trim();
  const durationSeconds = Number(formData.get("duration_seconds"));
  const language = String(formData.get("language") ?? "es").trim();
  const invalid = validateCommonFields({ topic, style, durationSeconds, language });
  if (invalid) redirect(`/dashboard/new?error=${encodeURIComponent(invalid)}`);
  const { data, error } = await supabase.from("video_requests").insert({
    user_id: user.id, topic, style, duration_seconds: durationSeconds, language,
    mode: "visual", status: "pending",
  }).select("id").single<{ id: string }>();
  if (error || !data) redirect("/dashboard/new?error=No+se+pudo+guardar+la+solicitud.+Intenta+de+nuevo.");
  redirect(`/dashboard/videos/${data.id}`);
}
