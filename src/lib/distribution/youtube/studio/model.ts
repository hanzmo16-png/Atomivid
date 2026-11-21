/** Publication preparation only. No executable upload or scheduler command exists. */
export type Draft = { version: 1; videoId: string; title: string; description: string; tags: string[]; privacy: "private" | "unlisted" | "public"; publishAt: string; thumbnail?: { name: string; sha256: string }; state: "draft" };
export type ReadyVideo = { id: string; title: string; mode: string };
export function draftKey(owner: string) { return `atomivid.youtube.draft.v1:${owner}`; }
export function validateDraft(d: Draft, ready: ReadyVideo[], now: number): string[] {
  const errors: string[] = [];
  if (d.version !== 1 || d.state !== "draft") errors.push("Estado de borrador inválido.");
  if (!ready.some(v => v.id === d.videoId)) errors.push("Selecciona un video terminado de tu biblioteca.");
  if (!d.title.trim() || d.title.length > 100 || /[<>]/.test(d.title)) errors.push("Título: 1–100 caracteres, sin < ni >.");
  if (d.description.length > 5000 || /[<>]/.test(d.description)) errors.push("Descripción: máximo 5000 caracteres, sin < ni >.");
  if (d.tags.some(t => !t.trim() || t.includes(",")) || d.tags.reduce((n,t) => n+t.length+(t.includes(" ")?2:0), Math.max(0,d.tags.length-1)) > 500) errors.push("Etiquetas: máximo 500 caracteres contando separadores y comillas.");
  if (!["private", "unlisted", "public"].includes(d.privacy)) errors.push("Privacidad inválida.");
  if (d.publishAt && (!Number.isFinite(Date.parse(d.publishAt)) || Date.parse(d.publishAt) < now + 15*60_000 || d.privacy !== "private")) errors.push("Programación preparada: privacidad privada y al menos 15 minutos en el futuro.");
  return errors;
}
export function parseDraft(raw: string): Draft | null {
  try { const d = JSON.parse(raw); if (d?.version !== 1 || d.state !== "draft" || typeof d.videoId !== "string" || typeof d.title !== "string" || typeof d.description !== "string" || typeof d.publishAt !== "string" || !Array.isArray(d.tags) || !d.tags.every((t: unknown) => typeof t === "string") || !["private","unlisted","public"].includes(d.privacy)) return null;
    // Explicit allowlist: tokens/unknown fields from imported JSON never survive.
    return { version:1, state:"draft", videoId:d.videoId, title:d.title, description:d.description, tags:d.tags, privacy:d.privacy, publishAt:d.publishAt, ...(d.thumbnail && typeof d.thumbnail.name === "string" && /^[a-f0-9]{64}$/.test(d.thumbnail.sha256) ? {thumbnail:{name:d.thumbnail.name,sha256:d.thumbnail.sha256}} : {}) };
  } catch { return null; }
}
export function durationSeconds(iso: string): number | null {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  return m && m.slice(1).some(Boolean) ? Number(m[1]||0)*3600+Number(m[2]||0)*60+Number(m[3]||0) : null;
}
export function videoKind(iso: string) { const s=durationSeconds(iso); return s === null ? "Formato no confirmado" : s<=180 ? "Posible Short · falta confirmar relación de aspecto" : "Video largo"; }
export function imageUrl(s?: string): string | undefined { try { const u=new URL(s??""); return u.protocol==="https:" && ["i.ytimg.com","yt3.ggpht.com","yt3.googleusercontent.com"].includes(u.hostname) ? u.href : undefined; } catch { return undefined; } }
export type OwnedChannel = { channel_id:string; owner_user_id:string; connection_id:string; status:string; title:string };
/** Defense in depth after the database owner filter; no foreign envelope can be resolved. */
export function ownedChannel(owner:string, channels:OwnedChannel[], channelId:string):OwnedChannel|null { return channels.find(c=>c.owner_user_id===owner&&c.channel_id===channelId&&c.status==="connected")??null; }
