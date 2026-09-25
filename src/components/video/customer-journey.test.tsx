import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { ResultView } from './ResultView';
import { RequestCard } from './RequestCard';
import { VideoDelivery } from './VideoDelivery';
import type { VideoRequestSummary } from '@/lib/video/request-view';
const router = {back(){},forward(){},refresh(){},push(){},replace(){},prefetch(){},bfcacheId:'test'};
const request: VideoRequestSummary = {id:'example',mode:'long_form',topic:'Documental',style:'Documental',duration_seconds:180,language:'es',status:'script_ready',video_path:null,error_message:null,script_json:{},progress_stage:null,render_attempts:0,render_started_at:null,created_at:'2026-09-25T00:00:00Z'};
function render(element: React.ReactNode) {return renderToStaticMarkup(<AppRouterContext.Provider value={router}>{element}</AppRouterContext.Provider>);}
test('ready documentary has a direct configuration exit',()=>{
  const html=render(<ResultView request={request} nowMs={0}/>);
  assert.match(html,/href="\/dashboard\/long-form\/configure\/example"/);
  assert.match(html,/Duración solicitada: 180s/);
});
test('confirmed but undispatched production avoids configuration redirect loop in both views',()=>{
  const confirmed={...request,long_form_confirmed_at:'2026-09-25T00:00:00Z'};
  for(const component of [<ResultView key="r" request={confirmed} nowMs={0}/>,<RequestCard key="c" request={confirmed} nowMs={0}/>]) {
    const html=render(component);
    assert.match(html,/Iniciar producción confirmada/);
    assert.doesNotMatch(html,/href="\/dashboard\/long-form\/configure/);
  }
});
test('completed video cannot offer regenerate and does not invent actual duration',()=>{
  const html=render(<ResultView request={{...request,status:'completed'}} videoUrl="https://example.test/watch" downloadUrl="https://example.test/download" nowMs={0}/>);
  assert.match(html,/href="https:\/\/example.test\/download"/);
  assert.match(html,/Descargar MP4/);
  assert.doesNotMatch(html,/Reintentar|Iniciar producción|Duración real:/);
  assert.match(html,/playsInline=""/i);
});
test('expired/unavailable URL offers read-only refresh',()=>{
  const html=render(<ResultView request={{...request,status:'completed'}} videoUrl={null} nowMs={0}/>);
  assert.match(html,/Actualizar enlaces/);
  assert.doesNotMatch(html,/Reintentar/);
});
test('missing download is not replaced by misleading watch URL',()=>{
  const html=render(<VideoDelivery videoUrl="https://example.test/watch" landscape/>);
  assert.doesNotMatch(html,/Descargar MP4/);
  assert.match(html,/enlace de descarga no está disponible/);
});
test('recorded avatar offers recording review instead of script editing',()=>{
  const html=render(<ResultView request={{...request,mode:'avatar',recorded_audio_path:'private/audio'}} nowMs={0}/>);
  assert.match(html,/Revisar grabación/);
});
