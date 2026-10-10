/**
 * USD 0 stand-in for Claude in end-to-end tests and demos: answers every orchestrated task for Claude that has no
 * delivery yet, exactly as the protocol asks (Entregas/<ID>__claude__hecha.md). `respond` decides the text.
 */
import type { Channel } from "./channel";
import { parseDeliveryName, parseHeader, parseRequestName } from "./protocol";

export async function simulatedClaudeTurn(channel: Channel, respond: (task: { id: string; text: string; attempt: number }) => string): Promise<string[]> {
  const [reqs, dels] = await Promise.all([channel.list("solicitudes"), channel.list("entregas")]);
  const answered = new Set(dels.map((d) => parseDeliveryName(d.name)).filter((p) => p?.agent === "claude").map((p) => p!.taskId));
  const written: string[] = [];
  for (const r of reqs) {
    const p = parseRequestName(r.name);
    if (!p || p.to !== "claude" || answered.has(p.taskId)) continue;
    const text = await channel.read(r.id);
    const h = parseHeader(text);
    if ((h.orquestar ?? "") !== "si") continue;
    const name = `${p.taskId}__claude__hecha.md`;
    await channel.createIfAbsent("entregas", name, `id: ${p.taskId}\nde: claude\nestado: hecha\n\n${respond({ id: p.taskId, text, attempt: Number(h.intento) || 1 })}`);
    written.push(name);
  }
  return written;
}
