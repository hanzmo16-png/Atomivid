"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Archiving is presentation-only. Never touch request status, paid operations,
 * supply holds, videos, script payloads or provider state.
 */
export async function setHistoryArchived(formData: FormData): Promise<void> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const requestId = String(formData.get("request_id") ?? "");
  const archive = formData.get("archive") === "1";
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestId)) throw new Error("Solicitud inválida");
  const service = createServiceClient();
  let q = service.from("video_requests")
    .update({ archived_at: archive ? new Date().toISOString() : null })
    .eq("id", requestId).eq("user_id", user.id);
  q = archive ? q.eq("status", "failed").is("archived_at", null) : q.not("archived_at", "is", null);
  const { data, error } = await q.select("id");
  if (error || !data || data.length !== 1) throw new Error("No se pudo cambiar el archivo de este proyecto.");
  revalidatePath("/dashboard");
}
