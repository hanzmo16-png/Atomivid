// Ensayo: reproducción, seek y «Actualizar enlaces» SIN re-producir (PR170/PR175). Lee ids de OUT/ids.json. USD 0.
const {BASE,db,login,log,shot,skipTour,fs,OUT}=require("./common.cjs");const TAG=process.env.TAG||"F";
(async()=>{const {b,p}=await login();const c=await db();const R=JSON.parse(fs.readFileSync(OUT+"/ids.json","utf8")).requestId;
 const row=async()=>(await c.query("select status,render_attempts,video_path,updated_at from video_requests where id=$1",[R])).rows[0];
 const disp=()=>fs.readFileSync("/workspace/atomivid-recraft/.e2e-local/logs/dispatches.jsonl","utf8").split("\n").filter(l=>l.includes(R)).length;
 const before=await row();const d0=disp();
 await p.goto(`${BASE}/dashboard/videos/${R}`);await skipTour(p);await p.waitForTimeout(3000);
 const v=p.locator("video").first();
 const st=()=>v.evaluate(e=>({t:e.currentTime,d:e.duration,paused:e.paused,rate:e.playbackRate,src:e.currentSrc.slice(0,80),err:e.error&&e.error.code,w:e.videoWidth,h:e.videoHeight}));
 await v.evaluate(e=>{e.muted=true;return e.play();}).catch(err=>log(TAG,"play() rechazado",String(err)));await p.waitForTimeout(3000);
 log(TAG,"reproduciendo",await st());
 await v.evaluate(e=>{e.playbackRate=1.5;e.currentTime=300;});await p.waitForTimeout(4000);
 const s1=await st();log(TAG,"tras seek a 300 s y velocidad 1.5",s1);await shot(p,`${TAG}-01-seek300`);
 const btn=p.getByTestId("refresh-links");
 if(await btn.count()){await btn.first().click();await p.waitForTimeout(6000);const s2=await st();log(TAG,"tras «Actualizar enlaces»",s2);await shot(p,`${TAG}-02-tras-actualizar`);
  log(TAG,"continuidad: posición conservada",s2.t>=s1.t-1,"velocidad conservada",s2.rate===s1.rate,"sigue reproduciendo",!s2.paused);}
 else log(TAG,"sin botón refresh-links");
 const after=await row();log(TAG,"sin re-producción: render_attempts",before.render_attempts,"→",after.render_attempts,"video_path igual",before.video_path===after.video_path,"despachos",d0,"→",disp());
 await b.close();await c.end();})().catch(e=>{console.error(e);process.exit(1)});
