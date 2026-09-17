"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createWeeklyGrowthPlan } from "@/lib/growth/plan";

const idSchema = z.string().uuid();
const weekSchema = z.string().date();
const editableBriefSchema = z.object({
  id: idSchema,
  hook: z.string().trim().min(10).max(280),
  topic: z.string().trim().min(10).max(500),
  callToAction: z.string().trim().min(3).max(120),
});

async function authenticatedClient() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  return { supabase, user };
}

export async function createGrowthPlan(formData: FormData) {
  const parsedWeek = weekSchema.safeParse(formData.get("weekStart"));
  if (!parsedWeek.success) redirect("/dashboard/growth?error=invalid-week");

  const { supabase, user } = await authenticatedClient();
  const { count, error: countError } = await supabase
    .from("growth_briefs")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .eq("week_start", parsedWeek.data);

  if (countError) redirect("/dashboard/growth?error=storage-not-ready");
  if ((count ?? 0) > 0) redirect("/dashboard/growth?notice=plan-exists");

  const plan = createWeeklyGrowthPlan(parsedWeek.data);
  const { error } = await supabase.from("growth_briefs").insert(
    plan.map((brief, index) => ({
      user_id: user.id,
      week_start: parsedWeek.data,
      sequence: index + 1,
      channel: brief.channel,
      pillar: brief.pillar,
      language: brief.language,
      objective: brief.objective,
      hook: brief.hook,
      topic: brief.topic,
      call_to_action: brief.callToAction,
      experiment_key: brief.experimentKey,
      scheduled_for: brief.scheduledFor,
    })),
  );

  if (error) redirect("/dashboard/growth?error=create-failed");
  revalidatePath("/dashboard/growth");
  redirect("/dashboard/growth?notice=plan-created");
}

export async function reviewGrowthBrief(formData: FormData) {
  const id = idSchema.safeParse(formData.get("id"));
  const status = z.enum(["approved", "rejected"]).safeParse(formData.get("status"));
  if (!id.success || !status.success) redirect("/dashboard/growth?error=invalid-action");

  const { supabase, user } = await authenticatedClient();
  const { error } = await supabase
    .from("growth_briefs")
    .update({ status: status.data, reviewed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", id.data)
    .eq("user_id", user.id);

  if (error) redirect("/dashboard/growth?error=review-failed");
  revalidatePath("/dashboard/growth");
  redirect(`/dashboard/growth?notice=${status.data}`);
}

export async function editGrowthBrief(formData: FormData) {
  const parsed = editableBriefSchema.safeParse({
    id: formData.get("id"),
    hook: formData.get("hook"),
    topic: formData.get("topic"),
    callToAction: formData.get("callToAction"),
  });
  if (!parsed.success) redirect("/dashboard/growth?error=invalid-edit");

  const { supabase, user } = await authenticatedClient();
  const { error } = await supabase
    .from("growth_briefs")
    .update({
      hook: parsed.data.hook,
      topic: parsed.data.topic,
      call_to_action: parsed.data.callToAction,
      status: "draft",
      reviewed_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", parsed.data.id)
    .eq("user_id", user.id);

  if (error) redirect("/dashboard/growth?error=edit-failed");
  revalidatePath("/dashboard/growth");
  redirect("/dashboard/growth?notice=updated");
}
