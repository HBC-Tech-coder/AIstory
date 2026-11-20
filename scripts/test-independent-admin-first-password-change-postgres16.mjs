import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {randomBytes,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const approvedImageReferences=Object.freeze([
 'postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94',
 'docker.m.daocloud.io/library/postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94',
]);
export function selectImageReference(args){
 assert.ok(Array.isArray(args),'PG16_IMAGE_ARGUMENTS_REJECTED');
 if(args.length===0)return approvedImageReferences[0];
 assert.ok(args.length===2&&args[0]==='--image'&&approvedImageReferences.includes(args[1]),'PG16_IMAGE_ARGUMENTS_REJECTED');
 return args[1];
}
function metadataRecord(value){
 assert.ok(value!==null&&typeof value==='object'&&!Array.isArray(value),'PG16_METADATA_SHAPE_REJECTED');
 assert.ok([Object.prototype,null].includes(Object.getPrototypeOf(value)),'PG16_METADATA_SHAPE_REJECTED');
 for(const key of Reflect.ownKeys(value))assert.ok(typeof key==='string'&&Object.hasOwn(Object.getOwnPropertyDescriptor(value,key),'value'),'PG16_METADATA_SHAPE_REJECTED');
 return value;
}
export function validateImageMetadata(value,image){
 assert.ok(approvedImageReferences.includes(image),'PG16_IMAGE_REFERENCE_REJECTED');
 const metadata=metadataRecord(value);
 assert.ok(typeof metadata.Id==='string'&&/^sha256:[a-f0-9]{64}$/.test(metadata.Id),'PG16_IMAGE_ID_REJECTED');
 assert.ok(metadata.Os==='linux'&&metadata.Architecture==='amd64','PG16_IMAGE_PLATFORM_REJECTED');
 assert.ok(metadata.Variant===undefined||metadata.Variant==='','PG16_IMAGE_PLATFORM_REJECTED');
 assert.ok(Array.isArray(metadata.RepoDigests)&&metadata.RepoDigests.length>0&&metadata.RepoDigests.length<=256,'PG16_IMAGE_DIGESTS_REJECTED');
 assert.ok(metadata.RepoDigests.every(ref=>typeof ref==='string'&&/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(ref)),'PG16_IMAGE_DIGESTS_REJECTED');
 assert.equal(new Set(metadata.RepoDigests).size,metadata.RepoDigests.length,'PG16_IMAGE_DIGESTS_REJECTED');
 assert.ok(metadata.RepoDigests.includes(image),'PG16_SELECTED_REPODIGEST_MISSING');
 // Docker's image/config Id is not assumed to equal the registry manifest digest.
 return metadata.Id;
}
export function validateContainerMetadata(value,expected){
 const c=metadataRecord(value),config=metadataRecord(c.Config),host=metadataRecord(c.HostConfig),network=metadataRecord(c.NetworkSettings);
 assert.ok(approvedImageReferences.includes(expected.image),'PG16_IMAGE_REFERENCE_REJECTED');
 assert.equal(c.Id,expected.id);assert.equal(c.Name,'/'+expected.name);
 assert.equal(c.Image,expected.imageId);assert.equal(config.Image,expected.image);
 assert.equal(c.Platform,'linux');assert.equal(metadataRecord(c.State).Running,true);
 assert.equal(metadataRecord(config.Labels)['aistory.purpose'],'first-password-change-qualification');
 assert.equal(host.NetworkMode,'none');assert.equal(host.AutoRemove,true);
 assert.ok(!host.PortBindings||Object.keys(metadataRecord(host.PortBindings)).length===0);assert.equal(host.PublishAllPorts,false);
 const tmpfs=metadataRecord(host.Tmpfs);
 assert.deepEqual(Object.keys(tmpfs).sort(),['/var/lib/postgresql/data','/var/run/postgresql']);
 assert.equal(tmpfs['/var/lib/postgresql/data'],'rw,noexec,nosuid,size=768m');
 assert.equal(tmpfs['/var/run/postgresql'],'rw,nosuid,size=64m');
 // Engines may expose --tmpfs only in HostConfig.Tmpfs, leaving Mounts empty.
 assert.ok(Array.isArray(c.Mounts)&&(c.Mounts.length===0||c.Mounts.length===2)&&c.Mounts.every(m=>metadataRecord(m).Type==='tmpfs'));
 if(c.Mounts.length)assert.deepEqual(c.Mounts.map(m=>m.Destination).sort(),Object.keys(tmpfs).sort());
 assert.ok(!network.Ports||Object.values(metadataRecord(network.Ports)).every(v=>v===null));
}
export function inspectSelectedImage(image,execute){
 assert.ok(approvedImageReferences.includes(image),'PG16_IMAGE_REFERENCE_REJECTED');
 const metadata=JSON.parse(checked(execute(['image','inspect',image,'--format','{{json .}}']),'IMAGE'));
 return validateImageMetadata(metadata,image);
}
const name='aistory-first-change-pg16-'+process.pid+'-'+randomBytes(4).toString('hex');
const migration='20260831113000_independent_admin_first_password_change_gate.sql';
const baseline=[
 '20260624135618_stories.sql','20260628095015_upsert_story_if_newer.sql','20260726174500_admin_console_p1.sql',
 '20260727193000_platform_provider_credentials.sql','20260728193000_phone_billing_p1.sql',
 '20260729093000_production_identity_billing_gate.sql','20260729183000_anonymous_phone_claim_gate.sql',
 '20260731120000_sensitive_identity_billing_privilege_hardening.sql','20260731183000_admin_identity_rpc_read_gate.sql',
 '20260801193000_hosted_byok_vault_gate.sql','20260801213000_hosted_byok_rpc_ambiguity_hardening.sql',
 '20260802113000_hosted_byok_rpc_runtime_qualification_hardening.sql','20260809113000_phone_admin_identity_gate.sql',
 '20260811193000_production_video_asset_metadata_gate.sql','20260828233000_independent_admin_principal_pg16_gate.sql',
 '20260829063000_independent_admin_qualification_residue_retirement_gate.sql',
];
const hash=b=>createHash('sha256').update(b).digest('hex');
const run=(args,input)=>spawnSync('docker',args,{input,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:2000000});
function checked(result,label){if(result.status!==0){const line=result.stderr?.match(/ERROR:\s*([^\n]+)/)?.[1]??'COMMAND_FAILED';throw Error(label+':'+line.replace(/DETAIL:.*/,'').slice(0,180));}return result.stdout.trim();}
let id;const gates=[];
const psqlArgs=(db='postgres')=>['exec','-i',id,'psql','-h','/var/run/postgresql','-U','postgres','-d',db,'-X','-qAt','-v','ON_ERROR_STOP=1','-1'];
const sql=(text,label,db='postgres')=>checked(run(psqlArgs(db),text),label);
const mustFail=(text,label,db='postgres')=>{assert.notEqual(run(psqlArgs(db),text).status,0,label);gates.push(label);};
const call=(fn,p)=>`set local role service_role;set local request.jwt.claim.role='service_role';select public.${fn}(${JSON.stringify(JSON.stringify(p))}::jsonb);`.replace(/"((?:[^"\\]|\\.)*)"::jsonb/,(_,s)=>"'"+JSON.parse('"'+s+'"').replaceAll("'","''")+"'::jsonb");
function parallel(text){return new Promise(resolve=>{const child=spawn('docker',psqlArgs(),{stdio:['pipe','pipe','pipe'],windowsHide:true});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('exit',status=>resolve({status,out:out.trim(),error:err.match(/ERROR:\s*([^\n]+)/)?.[1]?.slice(0,180)}));child.stdin.end(text);});}
const params={N:131072,r:8,p:1,keyLength:64,maxmem:268435456};
function fixture(n){const epoch=Buffer.alloc(16,n).toString('base64url'),digest=Buffer.alloc(64,n).toString('base64url');return {
 state:{credentialEpoch:epoch,passwordVerifier:{algorithm:'scrypt-v1',saltBase64url:Buffer.alloc(32,n).toString('base64url'),digestBase64url:digest,...params}},
 binding:{principal_ref:'iap_'+ 'a'.repeat(32),credential_binding_sha256:hash('synthetic-binding-'+n),credential_epoch_sha256:hash(epoch),password_verifier_reference_sha256:hash(digest),password_algorithm:'scrypt-v1',password_parameters:params},
};}
const before=fixture(1),after=fixture(2),ticket='5'.repeat(64);
let session='4'.repeat(64);
const time=()=>new Date().toISOString(),expiry=()=>new Date(Date.now()+900000).toISOString();
function loginPayload(binding,s=session){return {...binding,session_hash:s,family_hash:hash('family-'+s),bucket_hashes:['6'.repeat(64),'7'.repeat(64)],occurred_at:time(),expires_at:expiry()};}
const requestId='ipr_'+ 'A'.repeat(43);
const rotation=()=>({current_binding:before.binding,session_hash:session,ticket_hash:ticket,next_binding:after.binding,password_state:after.state,request_id:requestId});
if(process.argv[1]&&realpathSync(process.argv[1])===realpathSync(fileURLToPath(import.meta.url))){
const image=selectImageReference(process.argv.slice(2));
try{
 const imageId=inspectSelectedImage(image,run);
 id=checked(run(['run','--pull=never','--rm','-d','--name',name,'--label','aistory.purpose=first-password-change-qualification','--network','none',
  '--tmpfs','/var/lib/postgresql/data:rw,noexec,nosuid,size=768m','--tmpfs','/var/run/postgresql:rw,nosuid,size=64m',
  '-e','POSTGRES_HOST_AUTH_METHOD=trust',image,'-c','listen_addresses=','-c','unix_socket_directories=/var/run/postgresql','-c','check_function_bodies=on']),'START');
 assert.match(id,/^[a-f0-9]{64}$/);
 const c=JSON.parse(checked(run(['inspect',id,'--format','{{json .}}']),'METADATA'));
 validateContainerMetadata(c,{id,name,image,imageId});
 let stable=0,last='';const deadline=Date.now()+60000;
 while(Date.now()<deadline){const r=run(psqlArgs(),`select concat_ws('|',current_setting('server_version_num'),current_setting('server_version'),current_database(),current_user,split_part(pg_read_file('postmaster.pid'),E'\n',1),inet_server_addr() is null,pg_is_in_recovery());`);
  if(r.status===0&&r.stdout.trim()==='160015|16.15 (Debian 16.15-1.pgdg13+2)|postgres|postgres|1|t|f'){const now=r.stdout.trim();stable=last===now?stable+1:1;last=now;if(stable===2)break;}else{stable=0;last='';}await new Promise(r=>setTimeout(r,250));}
 assert.equal(stable,2);gates.push('exact_digest_final_PG16_unix_socket');
 sql(`create role anon nologin noinherit;create role authenticated nologin noinherit;create role service_role nologin bypassrls;
 create schema auth;create schema supabase_migrations authorization postgres;
 create table supabase_migrations.schema_migrations(version text primary key,name text not null,sha256 text not null,applied_at timestamptz not null default now());
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.role() returns text language sql stable as $$select nullif(current_setting('request.jwt.claim.role',true),'')$$;
 grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid(),auth.role() to anon,authenticated,service_role;`,'SYNTHETIC_BASE');
 for(const file of baseline){const b=await readFile('supabase/migrations/'+file);
  if(file.startsWith('20260829063000')){assert.equal(b.length,66767);assert.equal(hash(b),'4c958ca8af443e97f254fef1cfb1c2e6ea48f1907466d1b1c2ebc2282f598644');}
  sql(b.toString(),file);sql(`insert into supabase_migrations.schema_migrations(version,name,sha256) values('${file.slice(0,14)}','${file}','${hash(b)}');`,'BASE_LEDGER');}
 const m=await readFile('supabase/migrations/'+migration);
 const envelope=await readFile('scripts/apply-independent-admin-first-password-change-ledger.psql','utf8');
 const include='\\ir ../supabase/migrations/'+migration;
 assert.equal(envelope.split(include).length,2);
 assert.ok(envelope.includes(hash(m)));
 const apply=envelope.replace(include,()=>m.toString());
 assert.ok(apply.includes(m.toString()),'include expansion preserves every SQL dollar quote byte');
 const absent=()=>assert.equal(sql("select to_regclass('public.independent_admin_password_state') is null and not exists(select 1 from supabase_migrations.schema_migrations where version='20260831113000');",'ROLLBACK_NO_PARTIAL'),'t');
 mustFail("update supabase_migrations.schema_migrations set name='wrong_predecessor' where version='20260829063000';\n"+apply,'ledger_wrong_name');absent();
 mustFail("update supabase_migrations.schema_migrations set sha256=repeat('0',64) where version='20260829063000';\n"+apply,'ledger_wrong_sha');absent();
 mustFail('alter table supabase_migrations.schema_migrations add column statements text[];\n'+apply,'ledger_wrong_catalog');absent();
 // Fault injection is a synthetic test-only splice after DDL, before ledger append.
 const append='insert into supabase_migrations.schema_migrations(version,name,sha256) values(';
 mustFail(apply.replace(append,"select 1/0;\n"+append),'ledger_append_interruption_atomic_rollback');absent();
 sql(apply,'FIRST_CHANGE_PSQL_SINGLE_TRANSACTION');gates.push('migration_psql_minus_1_atomic_ledger');
 assert.equal(sql("select count(*) from supabase_migrations.schema_migrations where version='20260831113000' and name='"+migration+"' and sha256='"+hash(m)+"';",'LEDGER_IDENTITY'),'1');
 mustFail(apply,'ledger_envelope_replay_rejected');
 assert.equal(sql('select public.aistory_iap_first_change_posture();','POSTURE'),'20260831113000');
 mustFail(m.toString(),'migration_replay_rejected');
 const reg={registration:{...before.binding,request_id:requestId},password_state:before.state};
 for(const value of [null,3,'invalid']) {const bad=structuredClone(reg);bad.password_state.passwordVerifier.saltBase64url=value;mustFail(call('aistory_iap_first_change_bootstrap',bad),'null_type_verifier');}
 mustFail(call('aistory_independent_admin_initialize',reg.registration),'legacy_initializer_denied');
 mustFail(call('aistory_independent_admin_rotate_credential',{}),'legacy_rotation_denied');
 const init=await Promise.all([parallel(call('aistory_iap_first_change_bootstrap',reg)),parallel(call('aistory_iap_first_change_bootstrap',reg))]);
 assert.deepEqual(init.map(r=>r.status===0).sort(),[false,true],JSON.stringify(init.map(r=>r.error)));gates.push('atomic_concurrent_once_bootstrap');
 sql(call('aistory_independent_admin_commit_login',loginPayload(before.binding)),'TEMP_LOGIN');
 const sessionPayload={...before.binding,session_hash:session,occurred_at:time()};
 assert.equal(sql(call('aistory_independent_admin_verify_session',sessionPayload),'OLD_SESSION_RESTRICTED'),'');
 assert.equal(JSON.parse(sql(call('aistory_iap_first_change_verify_session',sessionPayload),'TEMP_VERIFY')).must_change_password,true);
 mustFail(call('aistory_independent_admin_read_snapshot',{...before.binding,session_hash:session,tenant_id:'platform'}),'direct_snapshot_denied');
 mustFail(call('aistory_independent_admin_rotate_session',{...before.binding,current_session_hash:session,next_session_hash:'8'.repeat(64),occurred_at:time(),next_expires_at:expiry()}),'temp_rotation_denied');
 for(const role of ['anon','authenticated','service_role'])for(const table of ['state','families','audit']) mustFail(`set local role ${role};select * from public.independent_admin_password_${table};`,'rls_'+role+'_'+table);
 for(const mutation of ['delete from','update'])mustFail(mutation==='update'?'update public.independent_admin_password_audit set event=event;':'delete from public.independent_admin_password_audit;','audit_immutable');
 mustFail('truncate public.independent_admin_password_audit;','audit_truncate');
 assert.equal(sql(`begin;alter table public.independent_admin_password_audit disable trigger independent_admin_password_audit_immutable;select public.aistory_iap_first_change_posture() is null;rollback;`,'TRIGGER_HOSTILE'),'t');
 assert.equal(sql(`begin;grant usage on sequence public.independent_admin_password_audit_sequence_seq to service_role;select public.aistory_iap_first_change_posture() is null;rollback;`,'SEQUENCE_HOSTILE'),'t');
 sql(call('aistory_iap_first_change_reserve',{...before.binding,session_hash:session,ticket_hash:ticket}),'RESERVE');
 // A ticket from an earlier temporary family cannot authorize the new family.
 const oldSession=session;session='e'.repeat(64);
 sql(call('aistory_independent_admin_commit_login',loginPayload(before.binding)),'REPLACE_TEMP_FAMILY');
 mustFail(call('aistory_iap_first_change_complete',rotation()),'cross_family_ticket');
 assert.equal(sql(call('aistory_independent_admin_verify_session',{...before.binding,session_hash:oldSession,occurred_at:time()}),'RETIRED_TEMP_SESSION'),'');
 for(let i=0;i<4;i++)assert.equal(JSON.parse(sql(call('aistory_iap_first_change_reserve',{...before.binding,session_hash:session,ticket_hash:ticket}),'RATE_RESERVE')).allowed,true);
 assert.equal(JSON.parse(sql(call('aistory_iap_first_change_reserve',{...before.binding,session_hash:session,ticket_hash:ticket}),'RATE_LIMIT')).allowed,false);
 sql("update public.independent_admin_password_state set window_started_at=clock_timestamp()-interval '16 minutes';",'SYNTHETIC_TIME_ADVANCE');
 sql(call('aistory_iap_first_change_reserve',{...before.binding,session_hash:session,ticket_hash:ticket}),'FRESH_WINDOW');
 mustFail(call('aistory_iap_first_change_complete',{...rotation(),session_hash:'9'.repeat(64)}),'cross_session_ticket');
 mustFail(call('aistory_iap_first_change_complete',{...rotation(),ticket_hash:'0'.repeat(64)}),'wrong_ticket');
 const badNext=rotation();badNext.next_binding.principal_ref='iap_'+ 'b'.repeat(32);mustFail(call('aistory_iap_first_change_complete',badNext),'cross_principal');after.binding.principal_ref=before.binding.principal_ref;
 mustFail(`create function public.synthetic_first_change_audit_failure() returns trigger language plpgsql as $$begin if new.event='password_change_succeeded' then raise exception 'synthetic audit failure';end if;return new;end;$$;
 create trigger synthetic_first_change_audit_failure before insert on public.independent_admin_password_audit for each row execute function public.synthetic_first_change_audit_failure();
 ${call('aistory_iap_first_change_complete',rotation())}`,'audit_failure_atomic_rollback');
 assert.equal(sql("select concat_ws(':',revision,must_change_password,(select count(*) from public.independent_admin_sessions where state='active')) from public.independent_admin_password_state;",'ROLLBACK_STATE'),'1:t:1');
 const changed=await Promise.all([parallel(call('aistory_iap_first_change_complete',rotation())),parallel(call('aistory_iap_first_change_complete',rotation()))]);
 assert.deepEqual(changed.map(r=>r.status===0).sort(),[false,true]);gates.push('atomic_concurrent_change_once');
 assert.equal(sql(`select concat_ws(':',(select count(*) from public.independent_admin_sessions where state='active'),
 (select count(*) from public.independent_admin_session_families where revoked_at is null),
 (select count(*) from public.independent_admin_password_audit where event='password_change_succeeded'));`,'FORCED_LOGOUT'),'0:0:1');
 mustFail(call('aistory_iap_first_change_complete',rotation()),'change_replay');
 mustFail(call('aistory_independent_admin_commit_login',loginPayload(before.binding,'a'.repeat(64))),'old_password_binding_login');
 const newSession='c'.repeat(64);sql(call('aistory_independent_admin_commit_login',loginPayload(after.binding,newSession)),'FRESH_LOGIN');
 assert.equal(JSON.parse(sql(call('aistory_independent_admin_verify_session',{...after.binding,session_hash:newSession,occurred_at:time()}),'NORMAL_VERIFY')).role,'super_admin');
 const snapshot=JSON.parse(sql(call('aistory_independent_admin_read_snapshot',{...after.binding,session_hash:newSession,tenant_id:'platform'}),'NORMAL_SNAPSHOT'));assert.ok(Array.isArray(snapshot.users));
 sql(call('aistory_independent_admin_revoke_session',{...after.binding,session_hash:newSession,occurred_at:time()}),'LOGOUT');
 assert.equal(sql('select public.aistory_independent_admin_gate_status();','GATE16_PRESERVED'),'20260829063000');
 assert.equal(sql('select public.aistory_iap_first_change_posture();','FINAL_POSTURE'),'20260831113000');
 console.log(JSON.stringify({status:'PASS_ISOLATED_PG16_FIRST_CHANGE',imageReference:image,imagePlatform:'linux/amd64',gates,migration:{bytes:m.length,sha256:hash(m)},network:'none',hostPorts:0,realCredentials:0,productionChanges:0}));
}finally{
 if(id){const c=JSON.parse(checked(run(['inspect',id,'--format','{{json .}}']),'CLEANUP_IDENTITY'));
  assert.equal(c.Name,'/'+name);assert.equal(c.Config.Labels['aistory.purpose'],'first-password-change-qualification');assert.equal(c.HostConfig.NetworkMode,'none');
  checked(run(['rm','-f',id]),'EXACT_CONTAINER_CLEANUP');assert.equal(checked(run(['ps','-aq','--filter','id='+id]),'CLEANUP_READBACK'),'');
  console.log('CLEANUP_PASS_owned_container_removed_tmpfs_only_no_volume_no_port');}
}
}
