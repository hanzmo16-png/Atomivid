import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  if (process.env.VERCEL_ENV === "preview" && request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Esta vista previa permite revisar la cuenta y videos existentes. La generación y los webhooks están bloqueados." }, { status: 403 });
  }
  return updateSession(request);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
