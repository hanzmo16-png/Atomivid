import { z } from 'zod';
import type { EditorialReview } from './editorial';
type Beats = { narration: string }[];
type Citation = { beatIndex: number; quote: string };
export function editorialCitations(review: EditorialReview): { path: string; citation: Citation }[] {
 return [...review.sections.map((citation,i)=>({path:`sections/${i}`,citation})),
  {path:'firstAnswer',citation:review.firstAnswer.evidence},{path:'ending',citation:review.ending.evidence},
  ...review.findings.flatMap((f,i)=>f.evidence.map((citation,j)=>({path:`findings/${i}/${j}`,citation})))];
}
const words=(s:string)=>s.trim().split(/\s+/).filter(Boolean).length;
/** Expand an ellipsis only when every >=3-word fragment occurs exactly once,
 * in order, in the SAME beat. No fuzzy matching, deletion, or invented text. */
export function resolveEditorialQuote(narration:string, quote:string):string|null {
 if(words(quote)<3)return null;
 if(narration.includes(quote))return quote;
 const fragments=quote.split(/\.{3}|…/).map(s=>s.trim());
 if(fragments.length<2 || fragments.some(s=>words(s)<3))return null;
 let first=-1,end=0;
 for(const fragment of fragments){
  const at=narration.indexOf(fragment);
  if(at<end || at<0 || narration.indexOf(fragment,at+1)!==-1)return null;
  if(first<0)first=at;
  end=at+fragment.length;
 }
 const literal=narration.slice(first,end);
 return literal.length<=1600?literal:null;
}
export function canonicalizeEditorialCitations(review:EditorialReview, beats:Beats):EditorialReview {
 const copy=structuredClone(review);
 for(const {citation} of editorialCitations(copy)){
  const literal=resolveEditorialQuote(beats[citation.beatIndex]?.narration??'',citation.quote);
  if(literal!==null)citation.quote=literal;
 }
 return copy;
}
export function invalidEditorialCitations(review:EditorialReview,beats:Beats){
 return editorialCitations(review).filter(({citation})=>words(citation.quote)<3 || !beats[citation.beatIndex]?.narration.includes(citation.quote));
}
export class EditorialEvidenceError extends Error {
 constructor(){super('La revisión editorial cita un pasaje que no corresponde al guion.');this.name='EditorialEvidenceError';}
}
export const CitationRepairSchema=z.object({replacements:z.array(z.object({path:z.string().min(1).max(80),quote:z.string().min(1).max(1600)})).max(24)});
/** Only replace requested quotes. Beat positions, findings, severity, judgments,
 * narration and source attribution cannot be edited through this contract. */
export function applyEditorialCitationRepairs(review:EditorialReview,beats:Beats,raw:unknown):EditorialReview {
 const replacements=CitationRepairSchema.parse(raw).replacements;
 const copy=structuredClone(review),invalid=invalidEditorialCitations(copy,beats);
 const expected=new Map(invalid.map(x=>[x.path,x.citation]));
 if(replacements.length!==expected.size || new Set(replacements.map(x=>x.path)).size!==expected.size)throw new EditorialEvidenceError();
 for(const patch of replacements){
  const target=expected.get(patch.path);
  if(!target || words(patch.quote)<3 || !beats[target.beatIndex]?.narration.includes(patch.quote))throw new EditorialEvidenceError();
  target.quote=patch.quote;
 }
 return copy;
}
