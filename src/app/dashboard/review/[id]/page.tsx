import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { GeneratedScript } from "@/lib/providers/types";
import { ScriptReview } from "./ScriptReview";

type VideoRequestRow = {
  id: string;
  topic: string;
  style: string;
  duration_seconds: number;
  status: string;
  script_json: GeneratedScript | null;
  error_message: string | null;
};

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data } = await supabase
    .from("video_requests")
    .select("id, topic, style, duration_seconds, status, script_json, error_message")
    .eq("id", id)
    .maybeSingle<VideoRequestRow>();

  if (!data || !data.script_json) {
    redirect("/dashboard");
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold text-gray-900">Revisar guion</h1>
      <p className="mt-1 text-sm text-gray-500">
        {data.topic} · {data.style} · {data.duration_seconds}s
      </p>

      <ScriptReview
        requestId={data.id}
        status={data.status}
        initialScript={data.script_json}
        errorMessage={data.error_message}
      />
    </div>
  );
}
