import { z } from 'zod';
import type { EditorialReview } from './editorial';
import { locateNormalized } from './text-locate';
type Beats = { narration: string; claims?: unknown }[];
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
 // Typography/whitespace/edge punctuation never invalidate a real passage.
 if(fragments.length<2)return locateNormalized(narration,quote);
 if(fragments.some(s=>words(s)<3))return null;
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
function literalLocations(beats:Beats,quote:string):number[] {
 return beats.flatMap((b,i)=>{const found:number[]=[];let at=b.narration.indexOf(quote);while(at!==-1){found.push(i);at=b.narration.indexOf(quote,at+1);}return found;});
}
export function canonicalizeEditorialCitations(review:EditorialReview, beats:Beats):EditorialReview {
 const copy=structuredClone(review);
 for(const ref of copy.citationLocations??[]){
  const citation=editorialCitations(copy).find(e=>e.path===ref.path)?.citation;
  const matches=literalLocations(beats,ref.quote);
  if(!citation||citation.quote!==ref.quote||citation.beatIndex!==ref.beatIndex||matches.length!==1||matches[0]!==ref.beatIndex)throw new EditorialEvidenceError();
 }
 for(const {citation} of editorialCitations(copy)){
  const literal=resolveEditorialQuote(beats[citation.beatIndex]?.narration??'',citation.quote);
  if(literal!==null)citation.quote=literal;
 }
 // A supplementary ID may be misplaced in the quote field. Keep it as a
 // separately audited claim reference ONLY when the same finding already cites
 // literal narration in the unique claim's actual beat. Never invent a quote.
 const claimBeats=(id:string)=>beats.flatMap((b,i)=>Array.isArray(b.claims)?b.claims.filter(c=>c && typeof c==='object' && c.id===id).map(()=>i):[]);
 const literalInBeat=(findingIndex:number,beatIndex:number)=>copy.findings[findingIndex]?.evidence.some(e=>e.beatIndex===beatIndex && words(e.quote)>=3 && beats[beatIndex]?.narration.includes(e.quote));
 for(const ref of copy.claimReferences??[]){
  const matches=claimBeats(ref.claimId);
  if(matches.length!==1 || matches[0]!==ref.beatIndex || !literalInBeat(ref.findingIndex,ref.beatIndex))throw new EditorialEvidenceError();
 }
 copy.findings.forEach((finding,findingIndex)=>{
  const references:NonNullable<EditorialReview['claimReferences']>=[];
  const keep=finding.evidence.filter(e=>{
   if(words(e.quote)>=3 && beats[e.beatIndex]?.narration.includes(e.quote))return true;
   const matches=claimBeats(e.quote);
   if(matches.length!==1 || !literalInBeat(findingIndex,matches[0]))return true;
   references.push({findingIndex,claimId:e.quote,beatIndex:matches[0],originalBeatIndex:e.beatIndex});
   return false;
  });
  if(references.length){finding.evidence=keep;copy.claimReferences=[...(copy.claimReferences??[]),...references];}
 });
 return copy;
}
export function invalidEditorialCitations(review:EditorialReview,beats:Beats){
 return editorialCitations(review).filter(({citation})=>words(citation.quote)<3 || !beats[citation.beatIndex]?.narration.includes(citation.quote));
}
export class EditorialEvidenceError extends Error {
 constructor(){super('La revisión editorial cita un pasaje que no corresponde al guion.');this.name='EditorialEvidenceError';}
}
export const CitationRepairSchema=z.object({replacements:z.array(z.object({path:z.string().min(1).max(80),quote:z.string().min(1).max(1600)})).max(24)});
/** Only replace requested quotes. Findings, severity, judgments,
 * narration and source attribution cannot be edited through this contract. */
export function applyEditorialCitationRepairs(review:EditorialReview,beats:Beats,raw:unknown):EditorialReview {
 const replacements=CitationRepairSchema.parse(raw).replacements;
 const copy=structuredClone(review),invalid=invalidEditorialCitations(copy,beats);
 const expected=new Map(invalid.map(x=>[x.path,x.citation]));
 if(replacements.length!==expected.size || new Set(replacements.map(x=>x.path)).size!==expected.size)throw new EditorialEvidenceError();
 for(const patch of replacements){
  const target=expected.get(patch.path);
  if(!target || words(patch.quote)<3)throw new EditorialEvidenceError();
  const literal=locateNormalized(beats[target.beatIndex]?.narration??'',patch.quote);
  if(literal!==null)patch.quote=literal;
  else {
   // Legacy correction responses can contain a real quote with a wrong block.
   // Repair the pointer only for ONE exact occurrence in the entire draft;
   // retain the original location and quote for audit. No fuzzy text matching.
   if(!patch.path.startsWith('findings/'))throw new EditorialEvidenceError();
   const matches=literalLocations(beats,patch.quote);
   if(matches.length!==1)throw new EditorialEvidenceError();
   copy.citationLocations=[...(copy.citationLocations??[]),{path:patch.path,originalBeatIndex:target.beatIndex,beatIndex:matches[0],quote:patch.quote}];
   target.beatIndex=matches[0];
  }
  target.quote=patch.quote;
 }
 return copy;
}
