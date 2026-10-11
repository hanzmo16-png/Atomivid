/**
 * In-process fake of the parts of Google's APIs the orchestrator uses (USD 0, no network), for the full simulated run
 * (`ORCH_MODE=simulate`) and tests. It is a `fetch` implementation, so the REAL DriveRestChannel and the REAL OAuth
 * refresh-token provider run against it:
 *  - POST oauth2.googleapis.com/token (refresh_token grant) → a short-lived access token;
 *  - every Drive call must carry that token (else 401);
 *  - files.list with the folder query, small pages + nextPageToken (exercises paging);
 *  - alt=media download, and export as text/plain for native Google Docs (alt=media is refused for them, like Drive);
 *  - multipart upload create (name, parents, content).
 */
export type FakeFile = { id: string; name: string; parent: string; mimeType: string; content: string; createdTime: string };

export type FakeFolder = { parents: string[]; ownedByMe: boolean; canAddChildren: boolean };

export class FakeDrive {
  files: FakeFile[] = [];
  /** Folder metadata for files.get (ownership, parents), like the coordination folder and its two subfolders. */
  folders = new Map<string, FakeFolder>();
  calls: { method: string; kind: string }[] = [];
  private seq = 0;
  private tokens = new Set<string>();
  constructor(private creds: { clientId: string; clientSecret: string; refreshToken: string }, private pageSize = 2, public scope = "https://www.googleapis.com/auth/drive") {}

  add(parent: string, name: string, content: string, mimeType = "text/markdown") {
    const f = { id: `f${++this.seq}`, name, parent, mimeType, content, createdTime: new Date(Date.UTC(2026, 9, 11, 0, this.seq)).toISOString() };
    this.files.push(f);
    return f;
  }

  readonly fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(url);
    const method = (init.method ?? "GET").toUpperCase();
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
      this.calls.push({ method, kind: "token" });
      const p = new URLSearchParams(String(init.body ?? ""));
      if (p.get("grant_type") !== "refresh_token" || p.get("refresh_token") !== this.creds.refreshToken || p.get("client_id") !== this.creds.clientId || p.get("client_secret") !== this.creds.clientSecret) return json({ error: "invalid_grant" }, 400);
      const token = `ya29.fake-${++this.seq}`;
      this.tokens.add(token);
      return json({ access_token: token, expires_in: 3599, token_type: "Bearer", scope: this.scope });
    }
    const auth = new Headers(init.headers).get("authorization") ?? "";
    if (!this.tokens.has(auth.replace(/^Bearer /, ""))) return json({ error: "unauthenticated" }, 401);
    if (method === "POST" && u.pathname === "/upload/drive/v3/files") {
      this.calls.push({ method, kind: "create" });
      const body = String(init.body ?? "");
      const boundary = new Headers(init.headers).get("content-type")?.match(/boundary=(.+)$/)?.[1] ?? "";
      const parts = body.split(`--${boundary}`).filter((x) => x.includes("Content-Type"));
      const meta = JSON.parse(parts[0].split("\r\n\r\n")[1].trim()) as { name: string; parents: string[]; mimeType: string };
      const content = parts[1].split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, "");
      const f = this.add(meta.parents[0], meta.name, content, meta.mimeType);
      return json({ id: f.id });
    }
    const m = u.pathname.match(/^\/drive\/v3\/files(?:\/([^/]+))?(\/export)?$/);
    if (method === "GET" && m && !m[1]) {
      this.calls.push({ method, kind: "list" });
      const parent = (u.searchParams.get("q") ?? "").match(/^'([^']+)' in parents and trashed = false$/)?.[1];
      if (!parent) return json({ error: "bad query" }, 400);
      const all = this.files.filter((f) => f.parent === parent);
      const start = Number(u.searchParams.get("pageToken") || 0);
      const page = all.slice(start, start + this.pageSize).map(({ id, name, mimeType, createdTime }) => ({ id, name, mimeType, createdTime, modifiedTime: createdTime }));
      return json({ files: page, ...(start + this.pageSize < all.length ? { nextPageToken: String(start + this.pageSize) } : {}) });
    }
    if (method === "GET" && m && m[1]) {
      const folder = this.folders.get(m[1]);
      if (folder && !m[2] && u.searchParams.get("alt") !== "media") {
        this.calls.push({ method, kind: "metadata" });
        return json({ id: m[1], mimeType: "application/vnd.google-apps.folder", parents: folder.parents, ownedByMe: folder.ownedByMe, capabilities: { canAddChildren: folder.canAddChildren } });
      }
      const f = this.files.find((x) => x.id === m[1]);
      if (!f) return json({ error: "not found" }, 404);
      const native = f.mimeType === "application/vnd.google-apps.document";
      if (m[2]) { this.calls.push({ method, kind: "export" }); return native && u.searchParams.get("mimeType") === "text/plain" ? new Response(f.content) : json({ error: "export only for Docs" }, 400); }
      this.calls.push({ method, kind: "download" });
      return !native && u.searchParams.get("alt") === "media" ? new Response(f.content) : json({ error: "use export for Docs" }, 403);
    }
    return json({ error: `unsupported ${method} ${u.pathname}` }, 400);
  };
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
