/**
 * On-demand "Actualizar disponibilidad": re-reads the balance of the refreshable providers a production
 * needs, reusing the SAME official billing GET as the supply monitor (refreshProviderSnapshot). It never
 * generates, reserves or charges. Repeated clicks are absorbed: a provider_api reading younger than
 * REFRESH_MIN_INTERVAL_MS is reused instead of querying the provider again. Freshness rules are untouched
 * (a provider_api balance is valid for 5 minutes; UNKNOWN is never sufficient; the start click re-checks).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { REFRESHABLE_PROVIDERS, refreshProviderSnapshot, type RefreshableProvider } from "@/lib/supply/monitor";

export const REFRESH_MIN_INTERVAL_MS = 60_000;
/** Same window the database applies to provider_api balances (pi_supply_balance_is_fresh). */
export const PROVIDER_API_VALIDITY_MS = 5 * 60_000;

export type RefreshOutcome = { refreshed: string[]; reused: string[]; manual: string[]; errors: Record<string, string> };

const NAME: Record<string, string> = { elevenlabs: "ElevenLabs", runway: "Runway", heygen: "HeyGen" };

export async function refreshDemandedCapacity(service: SupabaseClient, providers: string[], opts: {
  now?: () => number; refresh?: typeof refreshProviderSnapshot;
} = {}): Promise<RefreshOutcome> {
  const now = opts.now ?? Date.now, refresh = opts.refresh ?? refreshProviderSnapshot;
  const out: RefreshOutcome = { refreshed: [], reused: [], manual: [], errors: {} };
  for (const provider of [...new Set(providers)]) {
    if (!(REFRESHABLE_PROVIDERS as readonly string[]).includes(provider)) { out.manual.push(provider); continue; }
    const { data: last } = await service.from("pi_capacity_snapshots").select("checked_at").eq("provider", provider)
      .eq("reliability", "provider_api").order("checked_at", { ascending: false }).limit(1).maybeSingle();
    const age = last?.checked_at ? now() - Date.parse(last.checked_at) : Infinity;
    if (age >= 0 && age < REFRESH_MIN_INTERVAL_MS) { out.reused.push(provider); continue; }
    const name = NAME[provider] ?? provider;
    try {
      if (await refresh(service, provider as RefreshableProvider)) out.refreshed.push(provider);
      else out.errors[provider] = `La credencial de ${name} no está configurada en el servidor; no se puede consultar su saldo.`;
    } catch {
      // Never echo provider/database error text (it can carry account details).
      out.errors[provider] = `${name} no respondió a la consulta de saldo. Inténtalo de nuevo en un minuto; al iniciar se vuelve a consultar.`;
    }
  }
  return out;
}
