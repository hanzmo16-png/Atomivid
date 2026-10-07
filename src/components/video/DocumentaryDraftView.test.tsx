import {test} from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {DocumentaryDraftView} from './DocumentaryDraftView';
import {editorialFixture} from '@/lib/video/long-form/editorial.test-fixtures';
test('owner draft is visibly unapproved, escaped, and offers no paid action',()=>{
 const script=editorialFixture();script.beats[0].narration+='<script>alert(1)</script>';
 const html=renderToStaticMarkup(<DocumentaryDraftView value={{status:'unapproved',script}}/>);
 assert.match(html,/pendiente de aprobación/);assert.match(html,/Bloque 5/);
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<form'));assert.ok(!html.includes('<button'));
 assert.equal(renderToStaticMarkup(<DocumentaryDraftView value={{status:'approved',script}}/>),'');
 assert.equal(renderToStaticMarkup(<DocumentaryDraftView value={{status:'unapproved',script:{}}}/>),'');
});
