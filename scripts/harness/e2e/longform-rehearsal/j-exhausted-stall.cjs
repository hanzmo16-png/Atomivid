// Pedido colgado sin intentos restantes (estado preparado en BD local): al abrir su página debe quedar en un estado
// final con mensaje claro, en vez de «processing» para siempre. USD 0, sin proveedores.
const {BASE,db,login,log,shot,skipTour}=require("./common.cjs");
(async()=>{const R=process.env.REQUEST_ID;const c=await db();const old=new Date(Date.now()-30*60_000).toISOString();
 await c.query("update video_requests set status='processing',mode='long_form',render_attempts=3,render_started_at=$2::timestamptz,long_form_progress=jsonb_build_object('updatedAt',$3::text),supply_wait_started_at=null,error_message=null where id=$1",[R,old,old]);
 log("STALL","antes",(await c.query("select status,render_attempts,error_message from video_requests where id=$1",[R])).rows[0]);
 const {b,p}=await login();await p.goto(`${BASE}/dashboard/videos/${R}`);await skipTour(p);await p.waitForTimeout(2000);await shot(p,"STALL-detalle");
 log("STALL","después",(await c.query("select status,render_attempts,error_message from video_requests where id=$1",[R])).rows[0]);
 log("STALL","texto",(await p.locator("main").innerText()).slice(0,600).replace(/\s+/g," "));
 await b.close();await c.end();})().catch(e=>{console.error(e);process.exit(1);});
