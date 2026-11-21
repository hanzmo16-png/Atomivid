export function startFakeStorage(opts?: { bucket?: string; key?: string }): Promise<{
  url: string; key: string; objects: Map<string, { body: Buffer; contentType: string }>;
  log: { method: string; path: string }[]; close(): Promise<void>;
}>;
