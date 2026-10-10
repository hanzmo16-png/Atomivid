import {createClient} from '@supabase/supabase-js';
import {connectResolved} from '../lib/supabase-db';
import {readFileSync} from 'node:fs';
import {randomBytes,createCipheriv,publicEncrypt,constants} from 'node:crypto';
async function main(){
 if(process.env.GITHUB_RUN_ATTEMPT!=='1'||Date.now()>Date.parse('2026-10-10T01:15:00Z'))throw Error('ONE_TIME_WINDOW_CLOSED');
 const episode='922615a5-9673-42c0-8b6e-5f3a60193b18';
 const {client}=await connectResolved();let owner;
 try{const q=await client.query("select p.user_id::text as id from podcast_editor.propietarios p join podcast_editor.asignaciones a on a.user_id=p.user_id where a.episode_id=$1 and a.version=1 and a.permisos=array['escribir_entrada']::text[] and not a.revoked and a.expires_at>now()",[episode]);if(q.rows.length!==1)throw Error('OWNER_ASSIGNMENT_REQUIRED');owner=q.rows[0].id;
 const count=await client.query("select count(*)::int as n from storage.objects where bucket_id='podcast-editor' and name=$1",['episodios/'+episode+'/v1/entrada/LISTO.json']);if(count.rows[0].n)throw Error('INPUTS_ALREADY_READY');
 }finally{await client.end();}
 const url=process.env.SUPABASE_URL!.trim(), key=process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
 const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false}});
 const {data:u,error:ue}=await admin.auth.admin.getUserById(owner);if(ue||!u.user?.email)throw Error('OWNER_UNAVAILABLE');
 const {data:link,error:le}=await admin.auth.admin.generateLink({type:'magiclink',email:u.user.email});if(le||!link?.properties?.hashed_token)throw Error('LOGIN_LINK_FAILED');
 // Only a single-use magic-link hash is sealed. The owner upload process consumes it and signs out.
 const body=JSON.stringify({url,email:u.user.email,user_id:owner,token_hash:link.properties.hashed_token});
 const aes=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',aes,iv);
 const ciphertext=Buffer.concat([cipher.update(body,'utf8'),cipher.final()]);
 const sealed={key:publicEncrypt({key:readFileSync('ops/travis-session-public.pem'),padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},aes).toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')};
 console.log('TRAVIS_OWNER_LINK_SEALED='+Buffer.from(JSON.stringify(sealed)).toString('base64'));
 console.log(JSON.stringify({ownerLinkSealed:true,editorAccountUntouched:true,passwordsUnchanged:true}));
}
main().catch(()=>{console.error('OWNER_INPUT_SESSION_PREPARATION_FAILED');process.exitCode=1;});