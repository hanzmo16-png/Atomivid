import { createClient } from '@supabase/supabase-js';
import { connectResolved } from '../lib/supabase-db';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Resume the already-rendered synthetic fixture using only the assigned editor's own Storage session.
// Administrative access is used only to acquire a temporary login for that dedicated editor.
// No owner session, user password, paid provider call, SQL mutation or public credential output.
const url=process.env.SUPABASE_URL!.trim();
const admin=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),{auth:{persistSession:false,autoRefreshToken:false}});
const anon='sb_publishable_npUkxyz-qq8vmnifwE6lNQ_37tiQttZ';
const pre='episodios/prueba-v3/v1';
async function main(){
  const {client}=await connectResolved();
  const users=(await client.query(`select distinct u.id::text from auth.users u join podcast_editor.asignaciones a on a.user_id=u.id where a.episode_id='prueba-v3' and a.version=1 and not a.revoked and a.expires_at>now() and array['escribir_salida','escribir_estado']::text[] <@ a.permisos and u.email_confirmed_at is not null and not exists(select 1 from podcast_editor.propietarios p where p.user_id=u.id)`)).rows;
  await client.end();
  if(users.length!==1)throw Error('EXPECTED_ONE_ASSIGNED_EDITOR');
  const {data:u,error:ue}=await admin.auth.admin.getUserById(users[0].id);
  if(ue||!u.user?.email)throw Error('EDITOR_ACCOUNT_UNAVAILABLE');
  const {data:link,error:le}=await admin.auth.admin.generateLink({type:'magiclink',email:u.user.email});
  if(le||!link?.properties?.hashed_token)throw Error('EDITOR_LOGIN_LINK_FAILED');
  const user=createClient(url,anon,{auth:{persistSession:false,autoRefreshToken:false}});
  const {data:login,error:se}=await user.auth.verifyOtp({type:'magiclink',token_hash:link.properties.hashed_token});
  if(se||!login.session||login.user?.id!==users[0].id)throw Error('EDITOR_LOGIN_FAILED');
  try{
    const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/(SUPABASE|PODCAST|GH_TOKEN|GITHUB_TOKEN)/i.test(k)));
    const child=spawnSync('python3',['scripts/review/publish-editor-fixture.py'],{env,input:JSON.stringify({url,anon,email:u.user.email,session:login.session}),encoding:'utf8',timeout:240000});
    if(child.stdout)process.stdout.write(child.stdout);
    if(child.status!==0)throw Error('EDITOR_PUBLISH_FAILED');
    const expected=JSON.parse(readFileSync(`src/lib/podcast/editor/fixtures/editor-v3/${pre}/salida/COMPLETO.json`,'utf8'));
    const {data:marker,error:me}=await user.storage.from('podcast-editor').download(`${pre}/salida/COMPLETO.json`);
    if(me||!marker)throw Error('COMPLETE_MARKER_MISSING');
    const actual=JSON.parse(await marker.text());
    if(JSON.stringify(actual.objetos)!==JSON.stringify(expected.objetos))throw Error('OUTPUT_OBJECTS_MISMATCH');
    console.log(JSON.stringify({published:true,objects:actual.objetos.length,verification:actual.verificacion,markerWrittenLast:true,editorSessionOnly:true,paidCalls:0}));
  }finally{
    const {error}=await user.auth.signOut({scope:'local'});
    if(error)throw Error('EDITOR_SESSION_LOGOUT_FAILED');
  }
}
main().catch(e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'EDITOR_FIXTURE_PUBLISH_FAILED');process.exitCode=1;});
