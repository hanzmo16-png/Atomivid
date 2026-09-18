/** Only credit quantities/expiry/category are returned; never identities or credentials. */
export function creditSummary(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 100).map(creditSummary);
  if (!value || typeof value !== "object") return null;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(remaining|total|used|limit|balance|credits|credit|remaining_credits|total_credits|used_credits)$/.test(key) && typeof item === "number" && Number.isFinite(item)) result[key] = item;
    else if (/^(expires_at|expire_at|expiration|expiration_date|valid_until|type|plan|plan_name|status)$/.test(key) && typeof item === "string" && item.length < 100 && !/[@:/]{2}|@/.test(item)) result[key] = item;
    else if (item && typeof item === "object") result[key.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 40)] = creditSummary(item);
  }
  return result;
}
export async function readDidCredits(apiKey: string | undefined, request: typeof fetch = fetch) {
  if (!apiKey?.trim()) return { authenticated: false, error: "missing_key" };
  try {
    const response = await request("https://api.d-id.com/credits", {
      method: "GET", headers: { Authorization: `Basic ${Buffer.from(apiKey.trim()).toString("base64")}` },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) { await response.body?.cancel(); return { authenticated: false, status: response.status }; }
    return { authenticated: true, status: response.status, credits: creditSummary(await response.json()) };
  } catch { return { authenticated: false, error: "connection_or_response_failed" }; }
}
