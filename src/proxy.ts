import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { MissingEnvVarError } from "@/lib/env-errors";

/**
 * Runs before EVERY page and route. A missing/empty Supabase variable in the deployment's
 * environment used to surface as an opaque "Internal Server Error" on every path, thrown here
 * at the edge before any page or route function (and its logs) existed. It is now logged and
 * answered with a 503 that names the variable (name only, never a value), so a misconfigured
 * environment (e.g. a Preview deployment without the Production-scoped variables) is
 * diagnosable from the response itself. Behaviour with a complete configuration is unchanged.
 */
export async function proxy(request: NextRequest) {
  try {
    return await updateSession(request);
  } catch (e) {
    if (e instanceof MissingEnvVarError) {
      console.error(`[proxy] configuration error: ${e.message}`);
      return new NextResponse(
        `Configuration error: environment variable "${e.varName}" is missing or empty for this deployment environment. Check Vercel → Settings → Environment Variables and enable it for the environment of this deployment (Preview or Production), then redeploy.`,
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-atomivid-config-error": e.varName } },
      );
    }
    throw e;
  }
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
