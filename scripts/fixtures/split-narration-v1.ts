/** Frozen copy of the previous TTS splitter (before 2026-10-08), kept only as a regression oracle for timeline.test.ts. */
export function oldSplit(text: string, maxChars = 9000): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?…]+[.!?…]*\s*/g) ?? [text];
  const chunks: string[] = []; let current = "";
  for (const sentence of sentences) { if (current.length + sentence.length > maxChars && current) { chunks.push(current.trim()); current = ""; } current += sentence; }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length > 0 ? chunks : [text];
}
