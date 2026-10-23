import { DocumentaryNarrativeSchema } from "@/lib/video/long-form/documentary-script";
import { ResolvedEditorialReviewSchema, editorialBlockers, type EditorialIssue } from "@/lib/video/long-form/editorial";
import { creativeDirectionIssues, type CreativeHistoryEntry } from "@/lib/video/long-form/creative-direction";

const SOURCE_LABEL: Record<EditorialIssue["source"], string> = { reviewer: "Revisor editorial", structure: "Comprobación de estructura", duration: "Duración" };
/** Blocking reasons saved with the draft (passages-v1 checkpoints). Older drafts never saved the structural reasons,
 * so they are recomputed here (display only, no provider call) next to the reviewer's blockers. */
export function draftObservations(value: { review?: unknown; issues?: unknown; script?: unknown }, history: CreativeHistoryEntry[] = []) {
 const review = value.review ? ResolvedEditorialReviewSchema.safeParse(value.review) : null;
 const saved = Array.isArray(value.issues) ? (value.issues as EditorialIssue[]).filter(i => i && typeof i.text === "string" && i.source in SOURCE_LABEL) : null;
 const script = DocumentaryNarrativeSchema.safeParse(value.script);
 const blocking: EditorialIssue[] = saved ?? [
  ...(review?.success && script.success ? creativeDirectionIssues(script.data.creativeDirection, script.data.beats, history, history.length, { detail: true }).map(text => ({ source: "structure" as const, text })) : []),
  ...(review?.success ? editorialBlockers(review.data).map(text => ({ source: "reviewer" as const, text })) : [])];
 const suggestions = review?.success ? review.data.findings.filter(f => f.severity === "suggestion").map(f => `${f.explanation} ${f.repair}`) : [];
 return { blocking: blocking.map(i => ({ ...i, label: SOURCE_LABEL[i.source] })), suggestions, reviewed: Boolean(review?.success), reviewerBlocking: blocking.filter(i => i.source === "reviewer").length };
}

/** Server-rendered, owner-authorized draft. No production action is offered. */
export function DocumentaryDraftView({value,history=[]}:{value:unknown;history?:CreativeHistoryEntry[]}) {
 if(!value || typeof value!=="object" || !("status" in value) || value.status!=="unapproved" || !("script" in value))return null;
 const parsed=DocumentaryNarrativeSchema.safeParse(value.script);
 if(!parsed.success)return null;
 // Every blocking reason of THIS draft, labelled by origin; the reviewer's suggestions are listed apart and never block.
 const obs=draftObservations(value as { review?: unknown; issues?: unknown; script?: unknown },history);
 return <section className="mt-6 rounded-lg border border-line p-5">
  <h2 className="text-lg font-semibold">Borrador guardado · pendiente de aprobación</h2>
  <p className="mt-2 text-sm text-ink-muted">Puedes consultar el texto recuperado. Todavía necesita revisión antes de producir el video.</p>
  {obs.blocking.length ? <div className="mt-4"><h3 className="font-semibold">Qué impide aprobarlo</h3>
   {obs.reviewed && !obs.reviewerBlocking ? <p className="mt-1 text-sm text-ink-muted">El revisor editorial no tiene objeciones de contenido sobre este borrador.</p> : null}
   <ul className="mt-2 list-disc pl-5 text-sm">{obs.blocking.map((o,i)=><li key={i}><span className="font-medium">{o.label}:</span> {o.text}</li>)}</ul></div> : null}
  {obs.suggestions.length ? <details className="mt-4"><summary className="cursor-pointer font-semibold">Sugerencias del revisor (no bloquean)</summary>
   <ul className="mt-2 list-disc pl-5 text-sm">{obs.suggestions.map((o,i)=><li key={i}>{o}</li>)}</ul></details> : null}
  <h3 className="mt-4 font-semibold">{parsed.data.title}</h3>
  {parsed.data.beats.map((beat,index)=><details key={index} className="mt-3">
   <summary className="cursor-pointer font-medium">Bloque {index+1}</summary>
   <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{beat.narration}</p>
  </details>)}
 </section>;
}
