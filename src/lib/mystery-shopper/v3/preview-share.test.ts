import test from "node:test";
import assert from "node:assert/strict";
import { validatePreviewShare } from "../../../../scripts/mystery-shopper/preview-share";
const origin="https://pinned.vercel.app";
test("temporary share is scoped to exactly one HTTPS Preview and excludes arbitrary endpoints",()=>{
 assert.equal(validatePreviewShare(origin,origin+"/?_vercel_share=synthetic"),origin+"/?_vercel_share=synthetic");
 for(const v of ["http://pinned.vercel.app/?_vercel_share=x","https://other.vercel.app/?_vercel_share=x",origin+"/api/generate?_vercel_share=x",origin+"/",origin+"/?_vercel_share=x&other=y",origin+"/?_vercel_share=x#frag","https://user:pass@pinned.vercel.app/?_vercel_share=x"])
 assert.throws(()=>validatePreviewShare(origin,v));
});
