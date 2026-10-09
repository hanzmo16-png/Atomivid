import {createClient} from '@supabase/supabase-js';
import {connectResolved} from '../lib/supabase-db';
import {spawnSync} from 'node:child_process';

// Only the enrolled owner with temporary escribir_entrada on prueba-v3/v2 may publish.
// The editor account belongs to Grok and is never signed in or modified by this script.
const url=process.env.SUPABASE_URL!.trim();
const anon='sb_publishable_npUkxyz-qq8vmnifwE6lNQ_37tiQttZ';
const admin=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),{auth:{persistSession:false,autoRefreshToken:false}});
async function main(){
  if(process.env.OWNER_SESSION_AUTHORIZED!=='yes')throw Error('OWNER_SESSION_NOT_AUTHORIZED');
  const {client}=await connectResolved();
  let owners;
  try{
    owners=(await client.query(`select p.user_id::text as id from podcast_editor.propietarios p join podcast_editor.asignaciones a on a.user_id=p.user_id where a.episode_id='prueba-v3' and a.version=2 and a.permisos=array['escribir_entrada']::text[] and not a.revoked and a.expires_at>now()`)).rows;
    const outputs=await client.query(`select count(*)::int as n from storage.objects where bucket_id='podcast-editor' and (name like 'episodios/prueba-v3/v2/salida/%' or name like 'episodios/prueba-v3/v2/estado/%')`);
    if(outputs.rows[0].n!==0)throw Error('GROK_OUTPUT_AREA_NOT_EMPTY');
  }finally{await client.end();}
  if(owners.length!==1)throw Error('EXPECTED_ONE_ASSIGNED_OWNER');
  const {data:u,error:ue}=await admin.auth.admin.getUserById(owners[0].id);
  if(ue||!u.user?.email)throw Error('OWNER_UNAVAILABLE');
  const {data:link,error:le}=await admin.auth.admin.generateLink({type:'magiclink',email:u.user.email});
  if(le||!link?.properties?.hashed_token)throw Error('TEMPORARY_LOGIN_FAILED');
  const user=createClient(url,anon,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:login,error:se}=await user.auth.verifyOtp({type:'magiclink',token_hash:link.properties.hashed_token});
  if(se||!login.session)throw Error('OWNER_LOGIN_FAILED');
  try{
    if(login.user?.id!==owners[0].id)throw Error('OWNER_IDENTITY_MISMATCH');
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(SUPABASE|PODCAST|GH_TOKEN|GITHUB_TOKEN)/i.test(k)));
    const child=spawnSync('python3',['scripts/review/publish-editor-inputs.py'],{env,input:JSON.stringify({url,anon,email:u.user.email,session:login.session}),encoding:'utf8',timeout:240000});
    if(child.stdout)process.stdout.write(child.stdout);
    if(child.status!==0)throw Error('INPUT_PUBLISH_FAILED');
  }finally{
    const {error}=await user.auth.signOut({scope:'local'});
    console.log(JSON.stringify({temporaryOwnerLogout:!error}));
    if(error)throw Error('OWNER_LOGOUT_FAILED');
  }
}
main().catch(e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'INPUT_PREPARATION_FAILED');process.exitCode=1;});
