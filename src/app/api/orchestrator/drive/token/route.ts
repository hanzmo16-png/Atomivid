import { NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { bearer, verifyGithubOidc, ALLOWED_WORKFLOWS, DRIVE_TOKEN_AUDIENCE, GITHUB_OIDC_JWKS } from "@/lib/orchestrator/github-oidc";
import { driveWebConfig, mintDriveAccessToken, supabaseDriveConnectionStore, DriveConnectError } from "@/lib/orchestrator/drive-web-connect";
import { OAUTH_ENVIRONMENT } from "@/lib/orchestrator/google-oauth";

// Short-lived Drive access token for the orchestrator's GitHub Actions jobs. Authentication = a GitHub OIDC token
// (no shared secret): this repository, the default branch, the protected environment «orchestrator» and an allowed
// workflow file. The refresh token never leaves the server; the access token expires within the hour.
export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };
const REPOSITORY = "hanzmo16-png/Atomivid";
const DEFAULT_BRANCH = "claude/atomivid-mvp-setup-0079jv";

export async function POST(request: Request) {
  const jwt = bearer(request.headers.get("authorization"));
  if (!jwt) return NextResponse.json({ error: "unauthenticated" }, { status: 401, headers: noStore });
  const v = await verifyGithubOidc(jwt, { repository: REPOSITORY, defaultBranch: DEFAULT_BRANCH, environment: OAUTH_ENVIRONMENT, audience: DRIVE_TOKEN_AUDIENCE, workflows: ALLOWED_WORKFLOWS },
    async () => (await fetch(GITHUB_OIDC_JWKS, { cache: "no-store" })).json());
  if (!v.ok) return NextResponse.json({ error: v.reason }, { status: 403, headers: noStore });
  try {
    const t = await mintDriveAccessToken({ cfg: driveWebConfig(process.env), store: supabaseDriveConnectionStore(createServiceClient()), fetch });
    return NextResponse.json(t, { headers: noStore });
  } catch (e) {
    return NextResponse.json({ error: e instanceof DriveConnectError ? e.message : "no disponible" }, { status: 503, headers: noStore });
  }
}
