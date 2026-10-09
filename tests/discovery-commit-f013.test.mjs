import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const require = createRequire(import.meta.url);
let ts;try{ts=require('typescript');}catch{ts=require(join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'typescript'));}
const js=(path)=>ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},fileName:path}).outputText;
const R='src/';
let state;
const frag=(strings,...args)=>({strings:[...strings],args});frag.join=(list,sep)=>({list,sep});
const queryText=(e)=>!e||typeof e!=='object'?String(e):e.strings?e.strings.map((part,i)=>part+(i<e.args.length?queryText(e.args[i]):'')).join(''):e.list?e.list.map(queryText).join(queryText(e.sep)):String(e);
const ctx=vm.createContext({console,Set,Map,Error,Request,Response,ReadableStream,TextEncoder,Number,Object});
const mk=(mapping)=>new vm.SyntheticModule(Object.keys(mapping),function(){for(const [k,v] of Object.entries(mapping))this.setExport(k,v);},{context:ctx});
const drizzle=mk({sql:frag,eq:(...args)=>args,and:(...args)=>args,desc:x=>x});
const schema=mk({agents:{id:'id',tenantId:'tenantId'},discoverySessions:{agentId:'agentId',tenantId:'tenantId',status:'status',createdAt:'createdAt'},tenantUsers:{userId:'userId',tenantId:'tenantId'}});
const auth=new vm.SourceTextModule(js(R+'lib/authorization.ts'),{context:ctx});await auth.link(()=>{throw Error('unexpected auth import')});await auth.evaluate();
const guard=new vm.SourceTextModule(js(R+'lib/manager-mutation-authorization.ts'),{context:ctx});await guard.link((id)=>id==='drizzle-orm'?drizzle:id.endsWith('db/schema')?schema:auth);await guard.evaluate();
const tx={
 execute:async(q)=>{
  const t=queryText(q);state.events.push(t);
  if(/FROM agents/i.test(t))return {rows:[{id:'agent',lifecycle:'active'}]};
  if(/FROM tenants/i.test(t))return {rows:[{lifecycle:state.activeTenant?'active':'suspended'}]};
  if(/FROM users/i.test(t))return {rows:[{id:'actor'}]};
  if(/pg_advisory_xact_lock/i.test(t))return {rows:[{}]};
  if(/refresh_tokens/i.test(t))return {rows:state.familyActive?[{id:'active'}]:[]};
  if(/manager_sessions/i.test(t))return {rows:state.legacySessionActive?[{jti:'active'}]:[]};
  if(/pg_notify/i.test(t)){state.notifies++;return {rows:[]};}
  throw Error('Unexpected tx query: '+t);
 },
 query:{ tenantUsers:{findFirst:async()=>state.memberRole?{role:state.memberRole}:null},discoverySessions:{findFirst:async()=>null}},
 insert:()=>({values:async(value)=>{state.inserted.push(value);}}),
};
const database={
 query:{agents:{findFirst:async()=>{state.preflight?.();return {id:'agent',lifecycle:'active'};}}},
 transaction:async(callback)=>callback(tx),
};
const tenant=mk({requireActiveTenantInTransaction:async(t,tid)=>{
  const v=await t.execute(frag`SELECT lifecycle FROM tenants WHERE id=${tid} FOR SHARE`);
  if(v.rows[0].lifecycle!=='active')throw new Error('TENANT_SUSPENDED');
  return 'active';
}});
const supports={
 'next/server':mk({NextResponse:{json:(v,{status}= {})=>Response.json(v,{status:status||200})}}),
 'drizzle-orm':drizzle,
 '/db':mk({db:database}),
 '/db/schema':schema,
 '/lib/manager-auth':mk({validateWorkspaceManager:async()=>({tenantId:'tenant',jti:'jti',exp:1900000000,role:state.role,userId:state.userless?undefined:'actor',familyId:state.legacy?undefined:'family',kind:state.customer?'customer':'manager'})}),
 '/lib/nanoid':mk({nanoid:()=> 'random'}),
 '/lib/discovery':mk({validateDiscoveryRequest:(payload)=>payload?.cidr?{ok:true,data:payload}:{ok:false,error:'invalid request'}}),
 '/lib/log':mk({logError:()=>{}}),
 '/lib/tenant-guard':tenant,
};
const route=new vm.SourceTextModule(js(R+'app/api/agents/[id]/discovery/route.ts'),{context:ctx});
await route.link((name)=>name.endsWith('/lib/authorization')?auth:name.endsWith('/lib/manager-mutation-authorization')?guard:name.endsWith('/db/schema')?schema:name.endsWith('/db')?supports['/db']:name.endsWith('/lib/manager-auth')?supports['/lib/manager-auth']:name.endsWith('/lib/nanoid')?supports['/lib/nanoid']:name.endsWith('/lib/discovery')?supports['/lib/discovery']:name.endsWith('/lib/log')?supports['/lib/log']:name.endsWith('/lib/tenant-guard')?tenant:supports[name]);
await route.evaluate();
function reset(patch={}) {state={events:[],inserted:[],notifies:0,role:'admin',memberRole:'admin',familyActive:true,legacySessionActive:true,activeTenant:true,userless:false,legacy:false,customer:false,...patch};}
const call=(body)=>route.namespace.POST(new Request('http://localhost/api/agents/agent/discovery',{method:'POST',body:JSON.stringify(body)}),{params:Promise.resolve({id:'agent'})});
test('unchanged admin gets a running session and NOTIFY after tenant/session guard',async()=>{
 reset();const r=await call({cidr:'192.168.10.0/24'});assert.equal(r.status,201);
 assert.equal(state.inserted.length,1);assert.equal(state.notifies,1);
 const steps=state.events;assert.ok(steps.findIndex(t=>/FROM agents/i.test(t))<steps.findIndex(t=>/FROM tenants/i.test(t)));
 assert.ok(steps.findIndex(t=>/FROM tenants/i.test(t))<steps.findIndex(t=>/refresh_tokens/i.test(t)));
});
test('demotion after preflight, before body arrives rejects without write or NOTIFY',async()=>{
 reset();let ready;const preflight=new Promise(r=>ready=r);state.preflight=ready;
 let controller;const stream=new ReadableStream({start(c){controller=c;}});
 const req=new Request('http://localhost/api/agents/agent/discovery',{method:'POST',body:stream,duplex:'half'});
 const pending=route.namespace.POST(req,{params:Promise.resolve({id:'agent'})});await preflight;
 state.memberRole='viewer';controller.enqueue(new TextEncoder().encode(JSON.stringify({cidr:'192.168.10.0/24'})));controller.close();
 const r=await pending;assert.equal(r.status,403);assert.equal(state.inserted.length,0);assert.equal(state.notifies,0);
});
test('revoked family after preflight also rejects without writes',async()=>{
 reset({familyActive:false});const r=await call({cidr:'192.168.10.0/24'});
 assert.equal(r.status,403);assert.equal(state.inserted.length,0);assert.equal(state.notifies,0);
});
test('operator forbidden before insertion',async()=>{reset({role:'operator',memberRole:'operator'});const r=await call({cidr:'192.168.10.0/24'});assert.equal(r.status,403);assert.equal(state.notifies,0);});
test('malformed request does not insert even for admin',async()=>{reset();const r=await call({bad:true});assert.equal(r.status,400);assert.equal(state.inserted.length,0);});
test('userless bootstrap session is admitted for supported agent pairing operation',async()=>{reset({userless:true});const r=await call({cidr:'192.168.10.0/24'});assert.equal(r.status,201);});
test('legacy session revocation rejects when token lacks family',async()=>{reset({legacy:true,legacySessionActive:false});const r=await call({cidr:'192.168.10.0/24'});assert.equal(r.status,403);assert.equal(state.inserted.length,0);});
