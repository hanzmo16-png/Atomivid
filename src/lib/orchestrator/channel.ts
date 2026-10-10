/**
 * The Drive channel (Atomivid-Coordinacion-Codex-Grok): list/read/create files in Solicitudes/ and Entregas/.
 *  - MemoryChannel: tests and dry runs.
 *  - DriveRestChannel: Google Drive API v3 over fetch with an OAuth access token supplied by the caller
 *    (a Google service account with access to the folder, or a user OAuth token). Not configured yet: needs a Google
 *    credential that Hans creates (free) and stores as a GitHub secret — never in Drive.
 * Files are only ever created (append-only protocol); existence is checked first so re-runs never duplicate.
 */
export type ChannelFile = { id: string; name: string; modifiedTime: string; createdTime: string };
export type Folder = "solicitudes" | "entregas";

export interface Channel {
  list(folder: Folder): Promise<ChannelFile[]>;
  read(fileId: string): Promise<string>;
  /** Creates the file unless one with the same name already exists; returns whether it created it. */
  createIfAbsent(folder: Folder, name: string, content: string): Promise<{ created: boolean; id: string }>;
}

export class MemoryChannel implements Channel {
  files: (ChannelFile & { folder: Folder; content: string })[] = [];
  private seq = 0;
  private clock = Date.parse("2026-10-10T20:00:00Z");
  add(folder: Folder, name: string, content: string) {
    const t = new Date((this.clock += 1000)).toISOString();
    const f = { id: `f${++this.seq}`, name, folder, content, modifiedTime: t, createdTime: t };
    this.files.push(f);
    return f;
  }
  async list(folder: Folder) { return this.files.filter((f) => f.folder === folder).map(({ id, name, modifiedTime, createdTime }) => ({ id, name, modifiedTime, createdTime })); }
  async read(fileId: string) { return this.files.find((f) => f.id === fileId)?.content ?? ""; }
  async createIfAbsent(folder: Folder, name: string, content: string) {
    const existing = this.files.find((f) => f.folder === folder && f.name === name);
    if (existing) return { created: false, id: existing.id };
    return { created: true, id: this.add(folder, name, content).id };
  }
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class DriveRestChannel implements Channel {
  constructor(private folders: Record<Folder, string>, private token: () => Promise<string>, private fetchImpl: FetchLike = fetch) {}
  private async api(url: string, init: RequestInit = {}) {
    const res = await this.fetchImpl(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${await this.token()}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`DRIVE_HTTP_${res.status}`);
    return res;
  }
  async list(folder: Folder): Promise<ChannelFile[]> {
    const out: ChannelFile[] = [];
    let pageToken = "";
    do {
      const q = encodeURIComponent(`'${this.folders[folder]}' in parents and trashed = false`);
      const res = await this.api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=nextPageToken,files(id,name,modifiedTime,createdTime)&pageSize=200${pageToken ? `&pageToken=${pageToken}` : ""}`);
      const body = (await res.json()) as { files: ChannelFile[]; nextPageToken?: string };
      out.push(...body.files);
      pageToken = body.nextPageToken ?? "";
    } while (pageToken);
    return out;
  }
  async read(fileId: string) { return (await this.api(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`)).text(); }
  async createIfAbsent(folder: Folder, name: string, content: string) {
    const existing = (await this.list(folder)).find((f) => f.name === name);
    if (existing) return { created: false, id: existing.id };
    const boundary = `orch${Date.now()}`;
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [this.folders[folder]], mimeType: "text/markdown" })}\r\n--${boundary}\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
    const res = await this.api("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body });
    return { created: true, id: ((await res.json()) as { id: string }).id };
  }
}

/**
 * Access token for a Google service account (JSON key stored as a GitHub secret, never in Drive): signed JWT
 * (RS256) exchanged at oauth2.googleapis.com/token, scope drive (the folder must be shared with the account e-mail).
 * Cached until shortly before expiry. Free.
 */
export function serviceAccountTokenProvider(json: string, fetchImpl: FetchLike = fetch, now = () => Date.now()) {
  const key = JSON.parse(json) as { client_email: string; private_key: string; token_uri?: string };
  let cached: { token: string; exp: number } | null = null;
  return async () => {
    if (cached && cached.exp - 60_000 > now()) return cached.token;
    const { createSign } = await import("node:crypto");
    const iat = Math.floor(now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const aud = key.token_uri || "https://oauth2.googleapis.com/token";
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: key.client_email, scope: "https://www.googleapis.com/auth/drive", aud, iat, exp: iat + 3600 })}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key).toString("base64url");
    const res = await fetchImpl(aud, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${unsigned}.${signature}` });
    if (!res.ok) throw new Error(`GOOGLE_TOKEN_HTTP_${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: body.access_token, exp: now() + body.expires_in * 1000 };
    return cached.token;
  };
}
