import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {
 approvedImageReferences,selectImageReference,validateImageMetadata,
 validateContainerMetadata,inspectSelectedImage,
} from './test-independent-admin-first-password-change-postgres16.mjs';

const [official,mirror]=approvedImageReferences;
let cases=0,externalCalls=0;
const deny=fn=>{assert.throws(fn);cases++;};
const imageId='sha256:'+'b'.repeat(64); // Deliberately not the manifest digest.
const image=ref=>({Id:imageId,RepoDigests:[ref],Os:'linux',Architecture:'amd64'});
const container=ref=>({
 Id:'c'.repeat(64),Name:'/synthetic-pg16',Image:imageId,Platform:'linux',State:{Running:true},
 Config:{Image:ref,Labels:{'aistory.purpose':'first-password-change-qualification'}},
 HostConfig:{NetworkMode:'none',AutoRemove:true,PortBindings:{},PublishAllPorts:false,
  Tmpfs:{'/var/lib/postgresql/data':'rw,noexec,nosuid,size=768m','/var/run/postgresql':'rw,nosuid,size=64m'}},
 Mounts:[{Type:'tmpfs',Destination:'/var/lib/postgresql/data'},{Type:'tmpfs',Destination:'/var/run/postgresql'}],
 NetworkSettings:{Ports:{'5432/tcp':null}},
});
const expected=ref=>({id:'c'.repeat(64),name:'synthetic-pg16',imageId,image:ref});
const realFetch=globalThis.fetch;
globalThis.fetch=()=>{externalCalls++;throw Error('network forbidden');};
try{
 assert.equal(selectImageReference([]),official);cases++;
 for(const ref of approvedImageReferences){
  assert.equal(selectImageReference(['--image',ref]),ref);
  assert.equal(validateImageMetadata(image(ref),ref),imageId);
  validateContainerMetadata(container(ref),expected(ref));cases+=3;
  const emptyMounts=container(ref);emptyMounts.Mounts=[];validateContainerMetadata(emptyMounts,expected(ref));cases++;
  const observed=image(ref),original=JSON.stringify(observed),calls=[];
  assert.equal(inspectSelectedImage(ref,args=>{calls.push(args);return {status:0,stdout:JSON.stringify(observed)};}),imageId);
  assert.deepEqual(calls,[['image','inspect',ref,'--format','{{json .}}']]);assert.equal(JSON.stringify(observed),original);cases+=3;
 }
 // Exact host-reported mirror-only RepoDigests: old assertion rejects it. No fake alias insertion.
 assert.equal(image(mirror).RepoDigests.includes(official),false);cases++;
 deny(()=>validateImageMetadata(image(mirror),official));
 deny(()=>validateImageMetadata(image(official),mirror));
 for(const args of [null,{},['--image'],['--image',mirror,'--image',official],['--image='+mirror],['--unknown',mirror],
  ['--image','postgres:16'],['--image',imageId],['--image',mirror+' '],['--image',mirror.toUpperCase()],
  ['--image',mirror.replace('docker.m.daocloud.io','arbitrary.invalid')],['--image',mirror.replace('sha256:f','sha256:0')]])deny(()=>selectImageReference(args));
 for(const change of [
  m=>{m.Id='invalid';},m=>{m.Os='windows';},m=>{m.Architecture='arm64';},m=>{m.Variant='v8';},
  m=>{delete m.Os;},m=>{m.RepoDigests=null;},m=>{m.RepoDigests=[];},m=>{m.RepoDigests=[mirror,mirror];},
  m=>{m.RepoDigests=[mirror.replace('sha256:f','sha256:0')];},m=>{m.RepoDigests=['postgres:16'];},
  m=>{m.RepoDigests=[mirror.replace('library/postgres','other/postgres')];},m=>{m.RepoDigests=[mirror,42];},
 ]){const m=image(mirror);change(m);deny(()=>validateImageMetadata(m,mirror));
  let calls=0;deny(()=>inspectSelectedImage(mirror,args=>{assert.equal(args[0],'image');calls++;return {status:0,stdout:JSON.stringify(m)};}));assert.equal(calls,1);cases++;}
 let calls=0;deny(()=>inspectSelectedImage('postgres:16',()=>{calls++;}));assert.equal(calls,0);cases++;
 deny(()=>inspectSelectedImage(mirror,()=>({status:1,stdout:'',stderr:''})));
 deny(()=>inspectSelectedImage(mirror,()=>({status:0,stdout:'not-json'})));
 deny(()=>inspectSelectedImage(mirror,()=>({status:0,stdout:'null'})));
 for(const change of [
  c=>{c.Image='sha256:'+'d'.repeat(64);},c=>{c.Config.Image=official;},c=>{c.Config.Image='postgres:16';},
  c=>{c.Config.Image=mirror.replace('sha256:f','sha256:0');},c=>{c.Platform='windows';},
  c=>{c.Id='a'.repeat(64);},c=>{c.Name='/other';},c=>{c.State.Running=false;},c=>{c.Config.Labels={};},
  c=>{c.HostConfig.NetworkMode='bridge';},c=>{c.HostConfig.AutoRemove=false;},
  c=>{c.HostConfig.PortBindings={'5432/tcp':[{HostPort:'5432'}]};},c=>{c.HostConfig.PublishAllPorts=true;},
  c=>{c.Mounts[0].Type='bind';},c=>{c.Mounts.pop();},c=>{c.Mounts[0].Destination='/other';},
  c=>{c.HostConfig.Tmpfs={};},c=>{c.HostConfig.Tmpfs['/var/run/postgresql']='rw,nosuid,size=128m';},
  c=>{c.HostConfig.Tmpfs['/other']='rw';},c=>{c.HostConfig.Tmpfs['/var/lib/postgresql/data']='rw,nosuid,size=768m';},
  c=>{c.NetworkSettings.Ports={'5432/tcp':[{HostPort:'5432'}]};},
 ]){const c=container(mirror);change(c);deny(()=>validateContainerMetadata(c,expected(mirror)));}
 for(const value of [null,[],Object.create({Id:imageId}),{...image(mirror),[Symbol('unexpected')]:true}])deny(()=>validateImageMetadata(value,mirror));
 let getters=0;const accessor=image(mirror);Object.defineProperty(accessor,'Os',{get(){getters++;return 'linux';}});
 deny(()=>validateImageMetadata(accessor,mirror));assert.equal(getters,0);cases++;
 const source=await readFile(new URL('./test-independent-admin-first-password-change-postgres16.mjs',import.meta.url),'utf8');
 for(const pin of ["'--pull=never'","'--network','none'","'--tmpfs'","'listen_addresses='",'160015|16.15 (Debian 16.15-1.pgdg13+2)|postgres|postgres|1|t|f',
  '66767','4c958ca8af443e97f254fef1cfb1c2e6ea48f1907466d1b1c2ebc2282f598644']){assert.ok(source.includes(pin));cases++;}
 assert.ok(source.indexOf('const imageId=inspectSelectedImage(image,run);')<source.indexOf("id=checked(run(['run'"));cases++;
 const cli=spawnSync(process.execPath,[fileURLToPath(new URL('./test-independent-admin-first-password-change-postgres16.mjs',import.meta.url)),'--reject-before-docker'],{
  env:{SystemRoot:process.env.SystemRoot,PATH:''},encoding:'utf8',windowsHide:true,timeout:10000,
 });
 assert.equal(cli.status,1);assert.equal(cli.stdout,'');assert.ok(cli.stderr.includes('PG16_IMAGE_ARGUMENTS_REJECTED'));cases+=3;
 assert.equal(externalCalls,0);
 console.log(JSON.stringify({status:'PASS_PG16_EXACT_IMAGE_REFERENCE_CONTRACT',cases,approvedReferences:2,metadataRewritten:false,dockerCalls:0,networkCalls:0,
  mirrorEvidence:'synthetic fixture of host-reported mirror-only metadata; real local mirror availability not claimed'}));
}finally{globalThis.fetch=realFetch;}
