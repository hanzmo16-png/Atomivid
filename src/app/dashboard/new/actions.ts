"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

// Duraciones que ofrece el formulario — se valida contra esta misma lista
// en el servidor (nunca confiar solo en el <select> del cliente) para no
// dejar pasar una duración arbitraria que dispare un guion/voz/render
// desproporcionado. Ver también el CHECK de la migración 0007.
const ALLOWED_DURATIONS = [30, 60, 90];
const MAX_TOPIC_LENGTH = 500;
const MAX_STYLE_LENGTH = 100;

export async function createVideoRequest(formData: FormData) {
  const topic = String(formData.get("topic") ?? "").trim();
  const style = String(formData.get("style") ?? "").trim();
  const durationSeconds = Number(formData.get("duration_seconds"));

  if (!topic || !style || !durationSeconds) {
    redirect("/dashboard/new?error=Completa+todos+los+campos");
  }
  if (topic.length > MAX_TOPIC_LENGTH) {
    redirect(`/dashboard/new?error=El+tema+no+puede+superar+${MAX_TOPIC_LENGTH}+caracteres`);
  }
  if (style.length > MAX_STYLE_LENGTH) {
    redirect(`/dashboard/new?error=El+estilo+no+puede+superar+${MAX_STYLE_LENGTH}+caracteres`);
  }
  if (!ALLOWED_DURATIONS.includes(durationSeconds)) {
    redirect("/dashboard/new?error=Duración+no+válida");
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
