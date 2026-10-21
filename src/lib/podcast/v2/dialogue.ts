/** Puro (cliente y servidor): guion «A:/B:» → turnos. */
/** «A: texto» / «B: texto» por línea (o párrafos sin prefijo en modo individual) → turnos con IDs estables. */
export function parseDialogue(text: string, mode: "single" | "conversation"): { speaker: "A" | "B"; text: string }[] {
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n\s*\n|\n(?=[AB]\s*:)/).map((s) => s.trim()).filter(Boolean);
  return blocks.map((b) => {
    const m = /^([AB])\s*:\s*([\s\S]+)$/.exec(b);
    if (mode === "conversation" && !m) throw new Error(`Cada turno debe empezar con «A:» o «B:» («${b.slice(0, 40)}…»).`);
    return { speaker: (m?.[1] as "A" | "B") ?? "A", text: (m?.[2] ?? b).trim() };
  });
}
