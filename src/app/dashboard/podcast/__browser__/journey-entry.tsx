// Entrada del bundle de navegador SOLO para podcast-journey.browser.test.ts: monta los componentes REALES con un router
// y un fetch simulados y expone ganchos para que Playwright haga clics reales (efectos y sessionStorage incluidos).
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { NewEpisode } from "../NewEpisode";
import { VideoPanel } from "../[id]/VideoPanel";
import { SignOutForm } from "@/components/auth/SignOutForm";

type W = Window & { __fetches: Array<{ url: string; body: unknown }>; __pushes: string[]; __fetchReply: { status: number; body: unknown }; __mount: (kind: string, props: Record<string, unknown>) => void; __signedOut: number };
const w = window as unknown as W;
w.__fetches = []; w.__pushes = []; w.__signedOut = 0; w.__fetchReply = { status: 200, body: { id: "ep-nuevo" } };
window.fetch = (async (url: string, init?: RequestInit) => {
  w.__fetches.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
  return new Response(JSON.stringify(w.__fetchReply.body), { status: w.__fetchReply.status, headers: { "content-type": "application/json" } });
}) as typeof fetch;
const router = { back() {}, forward() {}, refresh() {}, prefetch() {}, push(u: string) { w.__pushes.push(u); }, replace(u: string) { w.__pushes.push(u); } };
let root: Root | null = null;
w.__mount = (kind, props) => {
  act(() => { if (!root) root = createRoot(document.getElementById("app")!); });
  const el = kind === "new" ? <NewEpisode {...(props as unknown as Parameters<typeof NewEpisode>[0])} />
    : kind === "panel" ? <VideoPanel {...(props as unknown as Parameters<typeof VideoPanel>[0])} />
    : <SignOutForm action={() => { w.__signedOut++; }}><button type="submit">Salir</button></SignOutForm>;
  act(() => { root!.render(<AppRouterContext.Provider value={router as never}>{el}</AppRouterContext.Provider>); });
};
