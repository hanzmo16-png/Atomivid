import { pathToFileURL } from "node:url";

// Read-only endpoint: https://docs.d-id.com/reference/getcredits
// Never log account data, credit balances, response bodies or credentials.
export async function checkDidAccess(apiKey, request = fetch) {
  if (!apiKey?.trim()) return { configured: false, authenticated: false, reason: "missing_key" };
  try {
    const response = await request("https://api.d-id.com/credits", {
      method: "GET",
      headers: { Authorization: `Basic ${Buffer.from(apiKey.trim(), "utf8").toString("base64")}` },
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    await response.body?.cancel();
    return { configured: true, authenticated: response.status === 200, status: response.status };
  } catch {
    return { configured: true, authenticated: false, reason: "connection_failed" };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await checkDidAccess(process.env.DID_API_KEY)));
}
