import path from "node:path";
import {writeFile} from "node:fs/promises";
import type {RealCtx} from "./real-missions";
import {campaign320SpendGate} from "../../src/lib/mystery-shopper/v3/campaign-320-adapters";
import type {LedgerState} from "../../src/lib/mystery-shopper/v3/ledger";
import {measureVideo} from "./av-check";
export function audiovisualGate(i:{real:boolean;kill:boolean;stopped:boolean;ledger:LedgerState|null;quote:number|null;runCap:number}){
 if(i.quote===null||!Number.isFinite(i.quote)||i.quote<=0||i.quote>3)return {ok:false,reason:"Costo audiovisual ausente o superior al tope; no se autoriza."};
 return campaign320SpendGate("video-podcast",{real:i.real,killSwitch:i.kill,stopped:i.stopped,ledger:i.ledger,amountUsd:3,runCapUsd:i.runCap,runCommittedUsd:0});
}
const SCRIPT=["Dos nubes pueden parecer iguales, pero solo una deja lluvia. Dentro flotan gotas diminutas y cristales de hielo. El aire en movimiento mantiene muchas de esas partículas suspendidas.", "Al chocar, algunas gotas crecen. Cuando pesan lo suficiente, comienzan a caer. Para entender ese proceso también importan la temperatura y las corrientes que atraviesan la nube.", "No toda esa agua llega al suelo. Si cae sobre una capa de aire seco, puede evaporarse durante el descenso. A veces vemos una cortina bajo la nube y no sentimos lluvia.", "Por eso, mirar una nube no garantiza saber qué tiempo hará. Un pronóstico necesita datos de humedad, viento y temperatura. Las nubes dan pistas: son parte de una historia mucho más amplia."].join("\n\n");
export async function runVideoPodcastReal(c:RealCtx){
 const p=c.page,key=`${c.jobId}-video-podcast`;let quote:number|null=null,episodeId="",ready:any=null;
 await c.goto('/dashboard/podcast');const w=p.getByTestId('podcast-wizard');await w.locator('[data-testid="wizard-step-title"]').waitFor({timeout:30000});
 if(await p.getByTestId('generacion-bloqueada').isVisible().catch(()=>false)){c.setHumanGate('Piloto audiovisual no habilitado para esta cuenta.');return;}
 const configured=await c.step('Configurar presentador autorizado y episodio mínimo desde la interfaz',async()=>{
  await w.getByTestId('modalidad-avatar').click();
  const host=w.getByTestId('anfitrion-victor').getByRole('radio');if(!await host.isEnabled())return {state:'BLOCKED',detail:'El anfitrión del catálogo no está disponible; no se carga una foto personal.'};await host.click();if(!await host.isChecked())return {state:'FAIL',detail:'No se verificó el anfitrión virtual seleccionado.'};
  await w.getByText('Opciones avanzadas de avatar',{exact:true}).click();
  await w.getByLabel('Frecuencia del avatar',{exact:true}).focus();await p.keyboard.press('End');if(await w.getByLabel('Frecuencia del avatar',{exact:true}).inputValue()!=='1')return {state:'FAIL',detail:'No se verificó presencia de avatar en todos los turnos.'};
  const max=w.getByLabel('Duración máxima del avatar',{exact:true});await max.focus();await p.keyboard.press('Home');for(let i=0;i<3;i++)await p.keyboard.press('ArrowRight');
  if(await max.inputValue()!=='20')return {state:'FAIL',detail:'No se verificó el límite por aparición.'};
  await w.getByRole('button',{name:'Siguiente',exact:true}).click();
  await w.getByLabel('Título del episodio',{exact:true}).fill(`QA audiovisual ${c.jobId.slice(-6)}: nubes y lluvia`);
  await w.getByLabel('Tema',{exact:true}).fill('Cómo se forman las nubes y por qué llueve');await w.getByLabel('Idioma',{exact:true}).selectOption('es');
  await w.getByLabel('Duración en minutos',{exact:true}).focus();await p.keyboard.press('Home');await w.getByLabel('Guion',{exact:true}).fill(SCRIPT);
  await w.getByRole('button',{name:'Siguiente',exact:true}).click();await w.getByRole('radio',{name:'Solo estudio y anfitriones (sin imágenes)',exact:true}).check();
  await w.getByRole('button',{name:'Siguiente',exact:true}).click();
  await w.getByLabel('Presupuesto máximo',{exact:true}).fill('3');await p.waitForTimeout(1200);
  if(await p.getByTestId('generacion-bloqueada').isVisible().catch(()=>false))return {state:'BLOCKED',detail:'Generación restringida por el gate de cuenta; no se fuerza una API.'};
  const table=w.getByTestId('wizard-estimate').locator('table');await table.waitFor({timeout:30000});const text=await table.locator('tr').filter({hasText:'Total estimado'}).innerText();
  const v=/([0-9]+[.,][0-9]{2})/.exec(text);quote=v?Number(v[1].replace(',','.')):null;
  await writeFile(path.join(c.out,'av-quote.json'),JSON.stringify({quote,budgetUsd:3,modality:'avatar',host:'virtual catalog victor',requestedSeconds:60,avatarFrequency:1,avatarMaxSeconds:20,noIllustrations:true}));
  const gen=w.getByRole('button',{name:'Generar episodio',exact:true});if(!await gen.isDisabled())return {state:'FAIL',detail:'Generación habilitada sin consentimiento.'};
  return {state:'PASS',detail:'Configuración y costo visibles. No se generó guion con IA.'};
 });if(configured.state!=='PASS')return;
 c.mark(c.cIdx(/Configuración audiovisual/),true,'Presentador virtual y guion configurados desde la interfaz.');
 c.mark(c.cIdx(/Costo antes/),quote!==null&&quote>0&&quote<=3,'Costo de la interfaz comprobado antes de autorizar.');
 if(!c.ledger){c.setHumanGate('No existe libro de gasto.');return;}
 const gate=audiovisualGate({real:c.real,kill:c.killSwitch?.()===true,stopped:!c.ledger.stopped||await c.ledger.stopped().catch(()=>true),ledger:await c.ledger.state().catch(()=>null),quote,runCap:c.runCapUsd??0});
 if(!gate.ok){c.setHumanGate(gate.reason);return;}
 const r=await c.ledger.reserve({key,module:'video-podcast',jobId:c.jobId,reservedUsd:3,at:new Date().toISOString()});if(!r.ok){c.setHumanGate(r.reason);return;}
 if(!c.killSwitch?.()||await c.ledger.stopped!().catch(()=>true)){c.setHumanGate('STOP antes del clic; reserva conservada.');return;}
 const accepted=await c.step('Autorizar una sola producción audiovisual con confirmación API',async()=>{
  const response=p.waitForResponse((x:any)=>{try{return /\/api\/podcast\/v3\/[0-9a-f-]{36}$/.test(new URL(x.url()).pathname)&&x.request().method()==='POST'&&x.request().postDataJSON()?.confirm===true&&x.request().postDataJSON()?.authorizedUsd===3;}catch{return false;}},{timeout:45000}).catch(()=>null);
  await w.getByLabel('Autorizo el cargo',{exact:true}).check();await w.getByRole('button',{name:'Generar episodio',exact:true}).click();const res=await response;
  if(!res||!res.ok())return {state:'BLOCKED',detail:'No se acreditó aceptación. No se reenvía y la reserva permanece.'};episodeId=new URL(res.url()).pathname.split('/').at(-1)!;
  await writeFile(path.join(c.out,'av-episode.json'),JSON.stringify({episodeId}));return {state:'PASS',detail:'La API confirmó la autorización del episodio. MP4 pendiente.'};
 });if(accepted.state!=='PASS')return;
 c.mark(c.cIdx(/Aceptación API/),true,'Confirmación autenticada de la API, sin reenvío.');
 const end=Date.now()+35*60000;
 while(Date.now()<end){const res=await p.request.get(`${c.baseUrl}/api/podcast/v3/${episodeId}`,{timeout:15000}).catch(()=>null);if(!res?.ok()){c.setHumanGate('Estado no verificable; no se reenvía ni se libera reserva.');return;}const s=await res.json();if(s.episode?.status==='ready'){ready=s;break;}if(s.episode?.status==='failed'){c.setHumanGate('El episodio falló; reserva conservada para conciliación del gasto parcial.');return;}await (c.sleep??((ms:number)=>p.waitForTimeout(ms)))(10000);}
 if(!ready?.video_url){c.setHumanGate('No se obtuvo MP4 en el plazo; sin reintento automático.');return;}
 await c.step('Descargar y verificar el MP4 real',async()=>{const res=await p.request.get(ready.video_url,{timeout:180000});if(!res.ok())return {state:'FAIL',detail:'La descarga privada no respondió correctamente.'};const f=path.join(c.out,`av-${episodeId}.mp4`);await writeFile(f,await res.body());const m=await measureVideo(f,{ffprobe:c.ffprobe,ffmpeg:c.ffmpeg});const ok=m.decodeOk&&!!m.video&&!!m.audio;c.mark(c.cIdx(/MP4 real/),ok,'Archivo descargado y sometido a ffprobe y decodificación completa.');c.media.push(await c.probe(f,60,null));return {state:ok?'PASS':'FAIL',detail:'MP4 real descargado y medido; calidad labial requiere revisión del archivo.'};});
 const spent=Number(ready.episode.cost_usd);if(ready.episode.cost_usd!==null&&Number.isFinite(spent)&&spent>=0&&spent<=3){await c.ledger.settle({key,spentUsd:Math.ceil((spent-Number.EPSILON)*100)/100,source:'API episodio ready cost_usd; proveedor nativo',at:new Date().toISOString()});c.addSpend(spent);c.mark(c.cIdx(/Gasto conciliado/),true,'Liquidación de costo final confirmada.');}else c.setHumanGate('Archivo obtenido; costo no acreditado, reserva conservada.');
}
