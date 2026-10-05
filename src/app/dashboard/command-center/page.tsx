import fs from "node:fs";
import { readSupplyOverview } from "@/lib/supply/admin";
import { SupplyPanel } from "./SupplyPanel";
import { readObligationOverview } from "@/lib/supply/obligations-server";
import { FinancePanel } from "./FinancePanel";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { isCommandCenterAdmin } from "@/lib/command-center/access";
import { CommandCenterService } from "@/lib/command-center/service";
import { supabaseSource } from "@/lib/command-center/sources";
import { buildViewModel } from "@/lib/command-center/view-model";
import { isWindowKey, type WindowKey } from "@/lib/command-center/windows";
import { CommandCenterView } from "./CommandCenterView";

// OWNER/ADMIN only (same gate as the API). A normal user gets 404 so the page's existence is
// not revealed; the API keeps 401/403. Always dynamic: global metrics are never cached.
export const dynamic = "force-dynamic";
export const metadata = { title: "Command Center", robots: { index: false, follow: false } };

const youtubeConfigured = (env: NodeJS.ProcessEnv) => Boolean(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.GOOGLE_OAUTH_REDIRECT_URI && env.YOUTUBE_TOKEN_ENC_KEY);

export default async function CommandCenterPage({ searchParams }: { searchParams: Promise<{ window?: string }> }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!isCommandCenterAdmin(user)) notFound();
  const sp = await searchParams;
  const window: WindowKey = isWindowKey(sp.window) ? sp.window : "7D";
  const sb = createServiceClient();
  const supplyPromise = readSupplyOverview(sb).catch(() => null);
  const financePromise = readObligationOverview(sb).catch(() => null);
  const service = new CommandCenterService({ source: supabaseSource(sb), now: () => new Date().toISOString() });
  const overview = await service.section(user, "overview", window);
  const vm = buildViewModel({ data: overview.data as Parameters<typeof buildViewModel>[0]["data"], window, generatedAt: overview.generatedAt, youtubeConfigured: youtubeConfigured(process.env), pwaReady: fs.existsSync("public/icons/icon-192.png") });
  const [supply, finance] = await Promise.all([supplyPromise, financePromise]);
  return <><SupplyPanel data={supply} /><FinancePanel data={finance} /><CommandCenterView vm={vm} /></>;
}
