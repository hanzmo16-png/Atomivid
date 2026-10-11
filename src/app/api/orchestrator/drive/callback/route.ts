import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { isCommandCenterAdmin } from "@/lib/command-center/access";
import { completeDriveConnect, driveWebConfig, supabaseDriveConnectionStore, DriveConnectError, PENDING_COOKIE } from "@/lib/orchestrator/drive-web-connect";

// Google redirects here with ?code&state. The code is exchanged server side, the account is checked against the
// coordination folder and only then the encrypted refresh token is stored. The browser goes back to the Command
// Center with a short result code: no token, no message from Google, nothing else in the address.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const back = (result: string) => {
    const res = NextResponse.redirect(new URL(`/dashboard/command-center?drive=${result}`, request.url), { headers: { "Cache-Control": "private, no-store" } });
    res.cookies.set(PENDING_COOKIE, "", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/api/orchestrator/drive", maxAge: 0 });
    return res;
  };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isCommandCenterAdmin(user)) return back("sin-permiso");
  try {
    await completeDriveConnect({ cfg: driveWebConfig(process.env), store: supabaseDriveConnectionStore(createServiceClient()), fetch },
      request.nextUrl.searchParams, request.cookies.get(PENDING_COOKIE)?.value);
    return back("conectado");
  } catch (e) {
    return back(e instanceof DriveConnectError ? e.code : "error");
  }
}
