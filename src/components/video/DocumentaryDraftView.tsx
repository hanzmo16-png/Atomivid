import { DocumentaryNarrativeSchema } from "@/lib/video/long-form/documentary-script";
import { ResolvedEditorialReviewSchema, editorialBlockers } from "@/lib/video/long-form/editorial";

/** Server-rendered, owner-authorized draft. No production action is offered. */
export function DocumentaryDraftView({value}:{value:unknown}) {
 if(!value || typeof value!=="object" || !("status" in value) || value.status!=="unapproved" || !("script" in value))return null;
 const parsed=DocumentaryNarrativeSchema.safeParse(value.script);
 if(!parsed.success)return null;
 // Editorial objections are shown as the reviewer's observations on THIS draft.
 const review="review" in value ? ResolvedEditorialReviewSchema.safeParse(value.review) : null;
 const objections=review?.success ? editorialBlockers(review.data) : [];
 return <section className="mt-6 rounded-lg border border-line p-5">
  <h2 className="text-lg font-semibold">Borrador guardado · pendiente de aprobación</h2>
  <p className="mt-2 text-sm text-ink-muted">Puedes consultar el texto recuperado. Todavía necesita revisión antes de producir el video.</p>
  {objections.length ? <div className="mt-4"><h3 className="font-semibold">Observaciones del revisor</h3>
   <ul className="mt-2 list-disc pl-5 text-sm">{objections.map((o,i)=><li key={i}>{o}</li>)}</ul></div> : null}
  <h3 className="mt-4 font-semibold">{parsed.data.title}</h3>
  {parsed.data.beats.map((beat,index)=><details key={index} className="mt-3">
   <summary className="cursor-pointer font-medium">Bloque {index+1}</summary>
   <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{beat.narration}</p>
  </details>)}
 </section>;
}
