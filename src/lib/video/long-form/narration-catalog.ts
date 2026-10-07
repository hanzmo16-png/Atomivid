import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EditorialReviewSchema, type EditorialReview } from './editorial';
import { EditorialEvidenceError } from './editorial-evidence';

type Beat = { narration: string };
export type NarrationExcerpt = { id: string; beatIndex: number; quote: string };
/** Immutable references derived from this exact draft. No model-generated text
 * or location is used as a pointer. Each excerpt is a literal 5–12-word span. */
export function narrationCatalog(beats: Beat[]): NarrationExcerpt[] {
 const revision=createHash('sha256').update(JSON.stringify(beats.map(b=>b.narration))).digest('hex').slice(0,16);
 return beats.flatMap((beat,beatIndex)=>{
  const tokens=[...beat.narration.matchAll(/\S+/g)];
  if(tokens.length<5)throw new EditorialEvidenceError();
  const excerpts:NarrationExcerpt[]=[];
  for(let start=0;start<tokens.length;start+=12){
   const from=tokens.length-start<5?Math.max(0,tokens.length-12):start;
   const to=Math.min(from+12,tokens.length)-1;
   excerpts.push({id:`${revision}:b${beatIndex}:w${from}`,beatIndex,quote:beat.narration.slice(tokens[from].index!,tokens[to].index!+tokens[to][0].length)});
  }
  return excerpts;
 });
}
const ref=z.object({excerptId:z.string().min(1).max(80)}).strict();
export const ReferencedEditorialReviewSchema=EditorialReviewSchema.extend({
 sections:z.array(EditorialReviewSchema.shape.sections.element.omit({beatIndex:true,quote:true}).extend(ref.shape).strict()).min(5).max(10),
 firstAnswer:EditorialReviewSchema.shape.firstAnswer.extend({evidence:ref}).strict(),
 ending:EditorialReviewSchema.shape.ending.extend({evidence:ref}).strict(),
 findings:z.array(EditorialReviewSchema.shape.findings.element.extend({evidence:z.array(ref).min(1).max(10)}).strict()).max(16),
}).strict();
export function resolveReferencedReview(value:unknown,beats:Beat[]):EditorialReview {
 const raw=ReferencedEditorialReviewSchema.parse(value),catalog=new Map(narrationCatalog(beats).map(e=>[e.id,e]));
 const resolve=(r:z.infer<typeof ref>)=>{
  const e=catalog.get(r.excerptId);if(!e)throw new EditorialEvidenceError();
  return {beatIndex:e.beatIndex,quote:e.quote};
 };
 return {...raw,sections:raw.sections.map(({excerptId,...section})=>({...section,...resolve({excerptId})})),
  firstAnswer:{...raw.firstAnswer,evidence:resolve(raw.firstAnswer.evidence)},ending:{...raw.ending,evidence:resolve(raw.ending.evidence)},
  findings:raw.findings.map(f=>({...f,evidence:f.evidence.map(resolve)}))};
}
export const REFERENCE_REVIEW_RULES=`CONTRATO DE REFERENCIAS: el catálogo narrationExcerpts pertenece a esta versión exacta del guion.
Para cada observación elige excerptId del fragmento que REALMENTE la respalda. Devuelve SOLO ese ID como evidencia: no copies ni parafrasees la cita y no escribas beatIndex.
Cubre una vez cada bloque en sections seleccionando un fragmento de ese bloque. Para firstAnswer/ending selecciona la respuesta narrada o el fragmento que demuestra la carencia.
El servidor recupera texto y ubicación del catálogo y vuelve a aplicar los controles editoriales. IDs inexistentes, de otro borrador o cobertura incorrecta detienen la revisión.
Las instrucciones anteriores sobre citas se satisfacen seleccionando referencias; no añadas campos quote o beatIndex a tu respuesta.`;
