import { z } from 'zod';
import { readDocumentaryJson, DocumentaryResponseError } from './json-response';
import { sectionFunctionRepairTargets } from './editorial-function-repair';

/** A completed, whole review may contain ONE orphan ] at the root object.
 * Remove that punctuation only: no strings, values, fields or judgement change.
 * All other syntax failures retain their original rejection. The whole schema
 * must pass (or contain only function labels handled by the existing repair).
 */
export function readEditorialJson(response: Parameters<typeof readDocumentaryJson>[0], schema: z.ZodType): unknown {
  try { return readDocumentaryJson(response); }
  catch (original) {
    if (!(original instanceof DocumentaryResponseError) || response.stop_reason !== 'end_turn') throw original;
    const text=response.content.filter(b=>b.type==='text').map(b=>b.text??'').join('').trim()
      .replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1');
    if (!text.startsWith('{') || !text.endsWith('}')) throw original;
    const stack:string[]=[]; let quoted=false,escaped=false,orphan=-1;
    for(let i=0;i<text.length;i++) {
      const c=text[i];
      if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
      if(c==='"'){quoted=true;continue;}
      if(c==='{'||c==='[')stack.push(c);
      else if(c==='}'||c===']') {
        const expected=c==='}'?'{':'[';
        if(stack.at(-1)===expected)stack.pop();
        else if(c===']'&&stack.length===1&&stack[0]==='{'&&orphan===-1)orphan=i;
        else throw original;
      }
      if(!stack.length&&i<text.length-1)throw original;
    }
    if(quoted||escaped||stack.length||orphan<0)throw original;
    let value:unknown;
    try{value=JSON.parse(text.slice(0,orphan)+text.slice(orphan+1));}catch{throw original;}
    if(!schema.safeParse(value).success&&!sectionFunctionRepairTargets(value,schema))throw original;
    return value;
  }
}
