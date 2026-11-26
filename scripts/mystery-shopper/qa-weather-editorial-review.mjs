// Actual Codex editorial review of the five QA beats read in this session.
// This is NOT an independent factual certification, not a provider critic call, and not the old model's approval.
import {editorialScriptHash,validateEditorialReview,editorialBlockers,editorialApprovalError} from '../../src/lib/video/long-form/editorial.ts';
export function reviewWeatherContext(script){
 const r=structuredClone(script),old=r.editorial;
 if(!old||old.status!=='approved'||r.beats.length!==5)throw Error('scope');
 const review={sections:[
 {beatIndex:0,quote:'La diferencia real empieza mucho antes, en cómo se formó esa nube.',function:'setup',contribution:'Plantea el contraste entre dos nubes y anticipa el mecanismo de formación sin aplazar toda la respuesta.'},
 {beatIndex:1,quote:'Tres caminos distintos, un mismo resultado inicial: una nube.',function:'new_information',contribution:'Distingue montaña, calentamiento y frente; los nuevos visuales solo ilustran su contexto, no muestran aire invisible.'},
 {beatIndex:2,quote:'Pero llegar a ser nube no garantiza que llueva.',function:'reversal',contribution:'Distingue formación y precipitación e introduce la composición; una fotografía general no acredita el interior de una nube.'},
 {beatIndex:3,quote:'Eso ocurre por colisión y coalescencia:',function:'consequence',contribution:'Explica crecimiento de gotas y declara el límite de las fuentes consultadas. La ilustración de gotas no es observación microscópica del proceso atmosférico.'},
 {beatIndex:4,quote:'Primero, un proceso, orográfico, convectivo o frontal,',function:'resolution',contribution:'Recapitula ascenso y crecimiento antes del cierre. Conserva la narración original y las limitaciones científicas ya señaladas.'}],
 firstAnswer:{delivered:true,evidence:{beatIndex:0,quote:'La diferencia real empieza mucho antes, en cómo se formó esa nube.'},explanation:'La primera pista física está dentro de las primeras 150 palabras; no se aplaza hasta el final.'},
 ending:{resolvesPromise:true,evidence:{beatIndex:4,quote:'Segundo, que las gotas dentro de esa nube crezcan por colisión'},explanation:'Responde a la promesa narrativa antes de la invitación final. No certifica que esta síntesis cubra toda la microfísica de precipitación.'},
 findings:[
 ...structuredClone(old.reviews.at(-1).findings),
 {kind:'unsupported_claim',severity:'suggestion',evidence:[{beatIndex:2,quote:'A gran altitud, donde el frío es extremo, las nubes están formadas solo por cristales de hielo.'},{beatIndex:4,quote:'para que llueva hacen falta dos cosas a la vez.'}],explanation:'La divulgación simplifica la composición de nubes y los mecanismos de precipitación. Esta prueba audiovisual no es revisión científica independiente ni demuestra exhaustividad de las fuentes.',repair:'Antes de publicación comercial, revisar con fuentes meteorológicas primarias las formulaciones absolutas; no usar imágenes de contexto como prueba de estas afirmaciones.'},
 {kind:'packaging_mismatch',severity:'suggestion',evidence:[{beatIndex:1,quote:'sobre diminutas partículas suspendidas, los núcleos de condensación.'}],explanation:'Las imágenes adaptadas son contexto visual. No muestran el movimiento invisible del aire ni condensación microscópica. Esta limitación debe mantenerse en el expediente QA.',repair:'Conservar el carácter ilustrativo y revisar el MP4 real antes de cualquier publicación.'}
 ]};
 const validated=validateEditorialReview(review,{beats:r.beats,storyPlan:old.storyPlan});if(editorialBlockers(validated).length)throw Error('blocking review');
 r.editorial={...old,model:'codex-qa-editorial-context-review; NOT independent scientific certification',corrected:true,scriptHash:editorialScriptHash(r.beats),reviews:[...old.reviews,validated]};
 if(editorialApprovalError(r))throw Error('review contract');return r;
}
