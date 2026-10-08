import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readEditorialJson } from './editorial-json';
import { EditorialReviewSchema } from './editorial';
import { editorialFixture, passingReview } from './editorial.test-fixtures';
import { DocumentaryResponseError } from './json-response';
const response=(text:string,stop_reason='end_turn')=>({stop_reason,content:[{type:'text',text}]});
const orphan=(text:string)=>text.slice(0,-1)+']}';
test('one orphan root array close preserves every original judgement and value',()=>{
 const value=passingReview(editorialFixture()), text=JSON.stringify(value);
 assert.deepEqual(readEditorialJson(response(orphan(text)),EditorialReviewSchema),value);
 assert.deepEqual(readEditorialJson(response(text),EditorialReviewSchema),value);
});
test('literal brackets, escapes and nested arrays inside evidence are preserved',()=>{
 const value=passingReview(editorialFixture());value.firstAnswer.explanation='Literal ] [ { } and "quoted" \\ text';
 assert.deepEqual(readEditorialJson(response(orphan(JSON.stringify(value))),EditorialReviewSchema),value);
});
test('only the existing section-function repair may follow syntax correction',()=>{
 const value=passingReview(editorialFixture()) as unknown as {sections:{function:string}[]};value.sections[3].function='complication';
 assert.deepEqual(readEditorialJson(response(orphan(JSON.stringify(value))),EditorialReviewSchema),value);
});
test('two orphans, inner orphan, truncation, prose and missing punctuation remain rejected',()=>{
 const text=JSON.stringify(passingReview(editorialFixture()));
 for(const invalid of [text.slice(0,-1)+']]}',text.replace('"delivered":true','"delivered":true]'),text.slice(0,-2),'prose '+orphan(text),text.replace('"delivered":true','"delivered" true')])
  assert.throws(()=>readEditorialJson(response(invalid),EditorialReviewSchema),DocumentaryResponseError);
 assert.throws(()=>readEditorialJson(response(orphan(text),'max_tokens'),EditorialReviewSchema),DocumentaryResponseError);
});
test('missing fields or altered approval values are never recovered',()=>{
 const value=passingReview(editorialFixture());
 for(const invalid of [{...value,firstAnswer:undefined},{...value,firstAnswer:{...value.firstAnswer,delivered:'true'}}])
  assert.throws(()=>readEditorialJson(response(orphan(JSON.stringify(invalid))),EditorialReviewSchema),DocumentaryResponseError);
});
