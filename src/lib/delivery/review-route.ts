/**
 * Testable core of GET /r/<slug> (see src/app/r/[slug]/route.ts for the Next.js wiring).
 * All I/O comes through `deps`, so the full authenticated flow can be exercised in a unit test
 * with fake dependencies: owner session -> 200 audio bytes / 206 Range, anonymous -> 307 login,
 * unknown slug -> 404, signed-in non-owner -> 403. Nothing here logs URLs, cookies or tokens.
 */
import { forwardableRange, passthroughStatus, resolveReviewObject, responseHeaders, upstreamRequest } from "./review-stream";

export type ReviewUser = { email?: string; email_confirmed_at?: string } | null;
export type ReviewRouteDeps = {
  getUser: () => Promise<ReviewUser>;
  /** Owner gate (production: canPrepareAvatar). */
  isOwner: (user: NonNullable<ReviewUser>) => boolean;
  /** Whether the owner gate has any configuration at all (env present). Reported as a header so a denial is diagnosable. */
  gateConfigured: () => boolean;
  fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
  supabaseUrl: () => string;
  serviceKey: () => string;
};

const NO_STORE: Record<string, string> = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex" };

export async function handleReviewRequest(request: Request, slug: string, deps: ReviewRouteDeps): Promise<Response> {
  const gate = { "X-Review-Gate": deps.gateConfigured() ? "configured" : "unconfigured" };
  const obj = resolveReviewObject(slug);
  if (!obj) return new Response("not found", { status: 404, headers: { ...NO_STORE, ...gate, "X-Review-Denied": "unknown-slug" } });

  const user = await deps.getUser();
  if (!user) {
    const login = new URL("/login", request.url);
    login.searchParams.set("redirectedFrom", `/r/${slug}`);
    return new Response(null, { status: 307, headers: { Location: login.toString(), ...NO_STORE, ...gate } });
  }
  if (!deps.isOwner(user)) {
    const reason = !deps.gateConfigured() ? "owner-gate-unconfigured" : !user.email_confirmed_at ? "email-unconfirmed" : "not-owner";
    return new Response(`forbidden: ${reason}`, { status: 403, headers: { ...NO_STORE, ...gate, "X-Review-Denied": reason } });
  }

  const range = forwardableRange(request.headers.get("range"));
  const up = upstreamRequest(deps.supabaseUrl(), deps.serviceKey(), obj, range);
  let upstream: Response;
  try {
    upstream = await deps.fetch(up.url, { headers: up.headers });
  } catch {
    return new Response("review object unavailable", { status: 502, headers: { ...NO_STORE, ...gate, "X-Review-Denied": "upstream-unreachable" } });
  }
  const status = passthroughStatus(upstream.status);
  if (status === 502) return new Response("review object unavailable", { status: 502, headers: { ...NO_STORE, ...gate, "X-Review-Denied": `upstream-${upstream.status}` } });
  return new Response(status === 416 ? null : upstream.body, { status, headers: { ...responseHeaders(upstream.headers, obj), ...gate } });
}
