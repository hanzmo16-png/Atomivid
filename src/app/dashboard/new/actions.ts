"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function createVideoRequest(formData: FormData) {
  const topic = String(formData.get("topic") ?? "").trim();
  const style = String(formData.get("style") ?? "").trim();
  const durationSeconds = Number(formData.get("duration_seconds"));

  if (!topic || !style || !durationSeconds) {
    redirect("/dashboard/new?error=Completa+todos+los+campos");
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { error } = await supabase.from("video_requests").insert({
    user_id: user.id,
    topic,
    style,
    duration_seconds: durationSeconds,
    status: "pending",
  });

  if (error) {
    redirect(`/dashboard/new?error=${encodeURIComponent(error.message)}`);
  }

  redirect("/dashboard?created=1");
}
