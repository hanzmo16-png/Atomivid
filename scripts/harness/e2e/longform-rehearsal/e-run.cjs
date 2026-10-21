const {BASE,db,login,log,shot,skipTour,fs,OUT,OWNER}=require("./common.cjs");const {execFileSync}=require("child_process");
const TOPIC=process.env.TOPIC;const TAG=process.env.TAG||"R";
(async()=>{let {b,p}=await login();const c=await db();
 if(!process.env.RESUME){
 // A. Crear por UI
 await p.goto(BASE+"/dashboard/long-form/new");await skipTour(p);
 await p.fill("input[name=topic]",TOPIC);await p.selectOption("select[name=language]","es");await p.fill("input[name=duration_minutes]","10");await shot(p,`${TAG}-A01-formulario`);
 await p.getByRole("button",{name:"Crear y revisar guion"}).click();await p.waitForURL(u=>!String(u).includes("/long-form/new"));
 const j=(await c.query("select id,request_id,status from documentary_script_jobs where user_id=$1 and input->'fields'->>'topic'=$2 order by created_at desc limit 1",[OWNER.id,TOPIC])).rows[0];
 fs.writeFileSync(OUT+"/ids.json",JSON.stringify({jobId:j.id,requestId:j.request_id}));log(TAG,"UI: solicitud creada por formulario",j);const R0=j.request_id;
 // B. Guion sintético por RPC productivas (NO UI, NO LLM)
 log(TAG,"NO-UI: guion sintético inyectado por RPC claim/finish",execFileSync("npx",["tsx","scripts/harness/e2e/longform-rehearsal/b-inject.ts"],{cwd:"/workspace/atomivid-recraft",env:{...process.env,TOPIC}}).toString().trim());
 // C. Revisar/configurar/confirmar por UI
 await p.goto(`${BASE}/dashboard/long-form/configure/${R0}`);await skipTour(p);
 for (const t of ["Revisar el guion","Ver estructura narrativa"]) await p.getByText(t).first().click().catch(()=>log("no expand",t));
 if(process.env.VOICE_ID){await p.locator("#reel_voice_picker").selectOption(process.env.VOICE_ID,{timeout:60000});log(TAG,"UI: voz elegida",await p.getByTestId("reel-voice-selected").innerText());}
 if(process.env.RECRAFT_REF){await p.locator("input[type=radio][value=recraft]").check();await p.locator("input[name=recraft_style_refs]").setInputFiles(process.env.RECRAFT_REF);if(process.env.RECRAFT_NOTE)await p.fill("input[name=recraft_style_note]",process.env.RECRAFT_NOTE);log(TAG,"UI: Recraft elegido con referencia",process.env.RECRAFT_REF);}
 await shot(p,`${TAG}-C01-revisar-plan`);fs.writeFileSync(`${OUT}/${TAG}-C01.txt`,await p.locator("main").innerText());
 log(TAG,"UI: controles de edición de guion en configurar (textarea):",await p.locator("main textarea").count());
 await p.getByRole("button",{name:"Confirmar y generar video"}).click();await p.waitForTimeout(8000);await shot(p,`${TAG}-C02-confirmado`);
 }
 const R=JSON.parse(fs.readFileSync(OUT+"/ids.json","utf8")).requestId;
 if(process.env.RESUME){await p.goto(`${BASE}/dashboard/videos/${R}`);await skipTour(p);await shot(p,`${TAG}-D01-antes-iniciar`);await p.getByRole("button",{name:process.env.BTN||"Iniciar producción"}).click();await p.waitForTimeout(8000);await shot(p,`${TAG}-D02-tras-iniciar`);log(TAG,"UI: pulsado Iniciar producción");}
 const t0=Date.now();let last="";
 for(;;){const r=(await c.query("select status,render_attempts,long_form_stage,long_form_progress,video_path,error_message from video_requests where id=$1",[R])).rows[0];
  const s=JSON.stringify([r.status,r.long_form_stage,r.long_form_progress&&r.long_form_progress.percent]);if(s!==last){log(TAG,"DB",Math.round((Date.now()-t0)/1000)+"s",r.status,r.long_form_stage,JSON.stringify(r.long_form_progress||{}).slice(0,300));last=s;}
  if(["completed","failed"].includes(r.status)){log(TAG,"FIN",r.status,(r.error_message||"").slice(0,400));break;}
  if((Date.now()-t0)%300000<16000){await p.goto(`${BASE}/dashboard/videos/${R}`).catch(()=>{});await shot(p,`${TAG}-D-progreso-${Math.round((Date.now()-t0)/60000)}min`);}
  if(Date.now()-t0>4*3600e3){log("TIMEOUT");break;}
  await new Promise(r=>setTimeout(r,15000));}
 await p.goto(`${BASE}/dashboard/videos/${R}`);await p.waitForTimeout(4000);await shot(p,`${TAG}-E01-resultado`);fs.writeFileSync(`${OUT}/${TAG}-E01.txt`,await p.locator("main").innerText());
 await p.reload();await p.waitForTimeout(3000);await shot(p,`${TAG}-E02-resultado-tras-recargar`);
 const src=await p.locator("video").first().getAttribute("src").catch(()=>null);log(TAG,"UI: <video src> presente",!!src);
 const dl=await Promise.all([p.waitForEvent("download",{timeout:600000}),p.getByText("Descargar video").first().click()]).then(([d])=>d).catch(e=>{log("descarga UI falló",String(e));return null;});
 if(dl){const f=`${OUT}/${TAG}-descargado.mp4`;await dl.saveAs(f);log(TAG,"UI: descargado",f,fs.statSync(f).size);}
 await b.close();await c.end();})().catch(e=>{console.error(e);log("ERROR",String(e));process.exit(1)});
