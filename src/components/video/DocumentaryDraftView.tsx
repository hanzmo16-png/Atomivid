import { DocumentaryNarrativeSchema } from "@/lib/video/long-form/documentary-script";

/** Server-rendered, owner-authorized draft. No production action is offered. */
export function DocumentaryDraftView({value}:{value:unknown}) {
 if(!value || typeof value!=="object" || !("status" in value) || value.status!=="unapproved" || !("script" in value))return null;
 const parsed=DocumentaryNarrativeSchema.safeParse(value.script);
 if(!parsed.success)return null;
 return <section className="mt-6 rounded-lg border border-line p-5">
  <h2 className="text-lg font-semibold">Borrador guardado · pendiente de aprobación</h2>
  <p className="mt-2 text-sm text-ink-muted">Puedes consultar el texto recuperado. Todavía necesita revisión antes de producir el video.</p>
  <h3 className="mt-4 font-semibold">{parsed.data.title}</h3>
  {parsed.data.beats.map((beat,index)=><details key={index} className="mt-3">
   <summary className="cursor-pointer font-medium">Bloque {index+1}</summary>
   <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">{beat.narration}</p>
  </details>)}
 </section>;
}
