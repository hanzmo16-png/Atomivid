import { createHash } from "node:crypto";

/** JSON with sorted keys: the same value always serializes to the same string. */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
}

export function stableHash(v: unknown, length = 16): string {
  return createHash("sha256").update(canonicalJson(v)).digest("hex").slice(0, length);
}
