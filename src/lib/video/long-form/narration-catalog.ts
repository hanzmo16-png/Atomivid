import { createHash } from 'node:crypto';
import { z } from 'zod';
import { EditorialReviewSchema, type EditorialReview } from './editorial';
import { EditorialEvidenceError } from './editorial-evidence';
import { locateNormalized } from './text-locate';

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
// Parsing tolerance: the excerptId is authoritative and extra keys (a copied
// quote, a beatIndex) are ignored. A missing/unknown ID falls back to locating the
// supplied passage in the original narration; the text is always derived here.
const evidenceRef=z.object({excerptId:z.string().max(200).optional(),quote:z.string().max(1600).optional(),beatIndex:z.number().int().optional()});
export const LenientReferencedReviewSchema=z.object({
 sections:z.array(EditorialReviewSchema.shape.sections.element.omit({beatIndex:true,quote:true}).extend(evidenceRef.shape)).min(5).max(10),
 firstAnswer:EditorialReviewSchema.shape.firstAnswer.extend({evidence:evidenceRef}),
 ending:EditorialReviewSchema.shape.ending.extend({evidence:evidenceRef}),
 findings:z.array(EditorialReviewSchema.shape.findings.element.extend({evidence:z.array(evidenceRef).min(1).max(10)})).max(16),
});
type LenientReview=z.infer<typeof LenientReferencedReviewSchema>;
export type ReferenceResolution={review:EditorialReview|null;unresolved:string[];droppedSuggestions:number};
export function resolveReviewReferences(value:unknown,beats:Beat[]):ReferenceResolution {
 const raw=LenientReferencedReviewSchema.parse(value),catalog=new Map(narrationCatalog(beats).map(e=>[e.id,e]));
 const resolve=(r:z.infer<typeof evidenceRef>):{beatIndex:number;quote:string}|null=>{
  const e=r.excerptId?catalog.get(r.excerptId):undefined;
  if(e)return {beatIndex:e.beatIndex,quote:e.quote};
  if(!r.quote)return null;
  const hinted=r.beatIndex!==undefined&&beats[r.beatIndex]?locateNormalized(beats[r.beatIndex].narration,r.quote):null;
  if(hinted)return {beatIndex:r.beatIndex!,quote:hinted};
  const found=beats.flatMap((b,i)=>{const q=locateNormalized(b.narration,r.quote!);return q?[{beatIndex:i,quote:q}]:[];});
  return found.length===1?found[0]:null;
 };
 const unresolved:string[]=[];let droppedSuggestions=0;
 const sections=raw.sections.map((section,i)=>{const ev=resolve(section);if(!ev)unresolved.push(`sections/${i}`);return {contribution:section.contribution,function:section.function,...(ev??{beatIndex:0,quote:''})};});
 const firstAnswer=resolve(raw.firstAnswer.evidence),ending=resolve(raw.ending.evidence);
 if(!firstAnswer)unresolved.push('firstAnswer');if(!ending)unresolved.push('ending');
 const findings=raw.findings.flatMap((f,i)=>{
  const evidence=f.evidence.map(resolve).filter((e):e is {beatIndex:number;quote:string}=>!!e);
  if(evidence.length)return [{...f,evidence}];
  if(f.severity==='suggestion'){droppedSuggestions++;return [];}
  unresolved.push(`findings/${i}`);return [];
 });
 if(unresolved.length)return {review:null,unresolved,droppedSuggestions};
 return {review:{...raw,sections,firstAnswer:{...raw.firstAnswer,evidence:firstAnswer!},ending:{...raw.ending,evidence:ending!},findings},unresolved,droppedSuggestions};
}
export function resolveReferencedReview(value:unknown,beats:Beat[]):EditorialReview {
 const {review}=resolveReviewReferences(value,beats);
 if(!review)throw new EditorialEvidenceError();
 return review;
}
export const ReferenceRepairSchema=z.object({replacements:z.array(z.object({path:z.string().min(1).max(80),excerptId:z.string().min(1).max(200)})).max(24)});
/** Bounded ID re-selection: only the listed paths may change, and only their
 * excerpt pointer. Judgments, severity and explanations are untouched. */
export function applyReferenceRepairs(value:unknown,unresolved:string[],repair:unknown):unknown {
 const raw=structuredClone(LenientReferencedReviewSchema.parse(value)) as LenientReview,wanted=new Set(unresolved);
 for(const {path,excerptId} of ReferenceRepairSchema.parse(repair).replacements){
  if(!wanted.has(path))throw new EditorialEvidenceError();
  const [kind,index]=path.split('/');
  if(kind==='sections'&&raw.sections[Number(index)])raw.sections[Number(index)]={...raw.sections[Number(index)],excerptId,quote:undefined,beatIndex:undefined};
  else if(kind==='firstAnswer')raw.firstAnswer.evidence={excerptId};
  else if(kind==='ending')raw.ending.evidence={excerptId};
  else if(kind==='findings'&&raw.findings[Number(index)])raw.findings[Number(index)].evidence=[{excerptId}];
  else throw new EditorialEvidenceError();
 }
 return raw;
}
export const REFERENCE_REVIEW_RULES=`CONTRATO DE REFERENCIAS: el catálogo narrationExcerpts pertenece a esta versión exacta del guion.
Para cada observación elige excerptId del fragmento que REALMENTE la respalda. Devuelve SOLO ese ID como evidencia: no copies ni parafrasees la cita y no escribas beatIndex.
Cubre una vez cada bloque en sections seleccionando un fragmento de ese bloque. Para firstAnswer/ending selecciona la respuesta narrada o el fragmento que demuestra la carencia.
El servidor recupera texto y ubicación del catálogo y vuelve a aplicar los controles editoriales. IDs inexistentes, de otro borrador o cobertura incorrecta detienen la revisión.
Las instrucciones anteriores sobre citas se satisfacen seleccionando referencias; no añadas campos quote o beatIndex a tu respuesta.`;
