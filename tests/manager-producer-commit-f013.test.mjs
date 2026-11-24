// Execute actual compiled Workspace mutation routes and the actual authorization
// guard. Only database, HTTP session, secret generation and audit boundaries are
// simulated; not PostgreSQL acceptance.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sqlIdentifier, workspaceSessionFixture } from './helpers/workspace-session-vm.mjs';
import { authorizationFixture } from './helpers/authorization-vm.mjs';
const require = createRequire(import.meta.url);
let ts;try{ts=require('typescript')}catch{ts=require(join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'typescript'))}
const from=(file)=>ts.transpileModule(readFileSync('src/'+file,'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const ctx=vm.createContext({console,Set,Map,Error,Number,Object,Request,Response,URL,Headers,URLSearchParams});
const stub=(exports)=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v)},{context:ctx});
const sql=(parts,...params)=>({parts,params});sql.join=(items,sep)=>({items,sep});
sql.identifier=sqlIdentifier;
const repr=(v)=>v?.parts?v.parts.map((p,i)=>p+(i<v.params.length?repr(v.params[i]):'')).join(''):v?.items?v.items.map(repr).join(repr(v.sep)):String(v);
const dr=stub({sql,and:(...args)=>args,eq:(...args)=>args,desc:(x)=>x});
let state;
const claims=()=>({tenantId:'tenant',jti:'jti',exp:1900000000,ver:state.legacy?1:2,sid:state.legacy?undefined:'sid',role:state.role,userId:'actor',kind:'manager',familyId:state.legacy?undefined:'family'});
const db={
 query:{tenants:{findFirst:async()=>({id:'tenant'})},plans:{findFirst:async()=>({id:'plan'})},tenantSubscriptions:{findFirst:async()=>null}},
 transaction:async(fn)=>fn(tx),
};
const tx={
 execute:async(q)=>{
  const text=repr(q);state.events.push(text);
  const policy=workspace.reply(text,claims(),state);if(policy)return policy;
  if(/FROM tenants/i.test(text))return {rows:[{id:'tenant',lifecycle:state.tenantActive?'active':'suspended'}]};
  if(/FROM users/i.test(text))return {rows:[{id:'actor'}]};
  if(/FROM tenant_subscriptions/i.test(text))return {rows:[]};
  if(/pg_advisory_xact_lock/i.test(text))return {rows:[{}]};
  if(/refresh_tokens/i.test(text))return {rows:state.familyActive?[{id:'token'}]:[]};
  if(/manager_sessions/i.test(text))return {rows:state.legacyActive?[{jti:'signed'}]:[]};
  throw Error('Unexpected tx.execute: '+text);
 },
 query:{tenantUsers:{findFirst:async()=>state.memberRole?{role:state.memberRole}:null},tenantSubscriptions:{findFirst:async()=>null},plans:{findFirst:async()=>({id:'plan'})}},
 update:()=>({set:(data)=>({where:async()=>{state.writes.push(data);return []}})}),
 insert:()=>({values:async(data)=>{state.writes.push(data)}}),
 select:()=>({from:()=>({where:()=>({for:async()=>[{id:'api-key'}]})})}),
};
const schema=stub({tenantUsers:{userId:'userId',tenantId:'tenantId'},users:{id:'id'},tenants:{id:'id',name:'name'},apiKeys:{id:'id',tenantId:'tenantId',hashedKey:'hashed_key',revokedAt:'revokedAt',odooEnabledRevision:'odooEnabledRevision'},plans:{id:'id',isActive:'isActive',isPublic:'isPublic'},tenantSubscriptions:{tenantId:'tenantId'}});
const auth=await authorizationFixture(ctx);
const workspace=await workspaceSessionFixture(ctx,dr);
const guard=new vm.SourceTextModule(from('lib/manager-mutation-authorization.ts'),{context:ctx});await guard.link((name)=>{
 if(name==='drizzle-orm')return dr;if(name.endsWith('db/schema'))return schema;if(name==='./authorization')return auth;if(name==='./workspace-session-security')return workspace.policy;
 throw Error('Unexpected guard import '+name);
});await guard.evaluate();
class TenantSuspendedError extends Error {}
class TenantDeletedError extends Error {}
const deps={
 'next/server':stub({NextResponse:{json:(data,{status=200}={})=>Response.json(data,{status})}}),
 'drizzle-orm':dr,
};
const lib={
 '/lib/authorization':auth,
 '/lib/manager-mutation-authorization':guard,
 '/lib/manager-auth':stub({validateWorkspaceManager:async()=>{
  state.preflight?.();return claims();
 }}),
 '/lib/tenant-guard':stub({TenantSuspendedError,TenantDeletedError,requireActiveTenantInTransaction:async(t,tid)=>{
   const v=await t.execute(sql`SELECT lifecycle FROM tenants WHERE id = ${tid} FOR SHARE`);
   if(v.rows[0]?.lifecycle!=='active')throw new TenantSuspendedError('TENANT_SUSPENDED');return 'active';
 }}),
 '/lib/entitlements':stub({requireTenantBillingAccess:async(t,id)=>{state.events.push('billing entitlement '+id)},isTenantBillingError:()=>false}),
 '/lib/manual-subscriptions':stub({ensurePendingManualSubscription:async(t,tenantId,planId)=>{
   assert.equal(t,tx);state.writes.push({tenantId,planId,status:'awaiting_activation'});
 }}),
 '/lib/odoo-auth':stub({generateOdooApiKey:()=>({raw:'secret',hashed:'hash',id:'key1'})}),
 '/lib/api-key-deletion':stub({deleteApiKeyInTransaction:async()=>{throw Error('Unexpected credential deletion in creation test')}}),
 '/lib/audit':stub({writeAuditEvent:async()=>{state.audit++}}),
 '/lib/log':stub({logError:()=>{}}),
 '/lib/action-error':stub({ActionError:class ActionError extends Error{constructor(msg,status,code){super(msg);this.status=status;this.code=code}}}),
 '/lib/request-limits':stub({hasBodyOverLimit:()=>false}),
};
const zField={trim:()=>zField,min:()=>zField,max:()=>zField,optional:()=>zField};const z=stub({z:{string:()=>zField,object:()=>({strict:()=>({safeParse:(data)=>({success:true,data})})})}});
const moduleFrom=(path)=>{const m=new vm.SourceTextModule(from(path),{context:ctx});return m};
async function load(path){const m=moduleFrom(path);await m.link((name)=>{
 if(deps[name])return deps[name];if(name==='zod')return z;if(name.endsWith('/db/schema'))return schema;
 if(name.endsWith('/db'))return stub({db});
 for(const [suffix,ref] of Object.entries(lib))if(name.endsWith(suffix))return ref;
 throw Error('Unmapped dependency '+name+' for '+path);
});await m.evaluate();return m.namespace;}
const setting=await load('app/api/settings/route.ts');
const keys=await load('app/api/odoo/keys/route.ts');
const onboarding=await load('app/api/onboarding/route.ts');
const reset=(changes={})=>{state={events:[],writes:[],audit:0,role:'admin',memberRole:'admin',familyActive:true,legacyActive:true,tenantActive:true,legacy:false,...changes}};
const req=(path,payload)=>new Request('https://localhost'+path,{method:'POST',body:JSON.stringify(payload)});
const patch=(payload)=>new Request('https://localhost/api/settings',{method:'PATCH',body:JSON.stringify(payload)});
test('actual workspace settings route commits an authorized mutation after live authority',async()=>{
 reset({role:'owner',memberRole:'owner'});const response=await setting.PATCH(patch({name:'New workspace'}));assert.equal(response.status,200);assert.equal(state.writes.length,1);
 assert.ok(state.events.findIndex(v=>v.includes('FROM tenants'))<state.events.findIndex(v=>v.includes('refresh_tokens')));
 assert.equal(state.audit,1);
});
test('actual settings route rejects actor demoted after preflight without writes',async()=>{
 reset({role:'owner',memberRole:'viewer'});const response=await setting.PATCH(patch({name:'New workspace'}));assert.equal(response.status,403);assert.equal(state.writes.length,0);assert.equal(state.audit,0);
});
test('actual settings route rejects family revocation without writes',async()=>{
 reset({role:'owner',memberRole:'owner',familyActive:false});const response=await setting.PATCH(patch({name:'New workspace'}));assert.equal(response.status,401);assert.equal((await response.json()).code,'SESSION_EXPIRED');assert.equal(state.writes.length,0);assert.equal(state.audit,0);
});
test('actual Odoo credential route inserts only after matching live Manager authority',async()=>{
 reset();const response=await keys.POST(req('/api/odoo/keys',{name:'Printer key'}));assert.equal(response.status,201);assert.equal(state.writes.length,1);assert.equal(state.audit,1);
});
test('actual Odoo credential route refuses revoked family before issuing key',async()=>{
 reset({familyActive:false});const response=await keys.POST(req('/api/odoo/keys',{name:'Printer key'}));assert.equal(response.status,401);assert.equal((await response.json()).code,'SESSION_EXPIRED');assert.equal(state.writes.length,0);assert.equal(state.audit,0);
});
test('actual Odoo credential route refuses demoted actor before issuing key',async()=>{
 reset({memberRole:'viewer'});const response=await keys.POST(req('/api/odoo/keys',{name:'Printer key'}));assert.equal(response.status,403);assert.equal(state.writes.length,0);
});
test('old owner session cannot create commercial subscription or edit workspace through onboarding',async()=>{
 reset({role:'owner',memberRole:'owner'});
 const response=await onboarding.POST(req('/api/onboarding',{workspaceName:'New workspace',planId:'plan'}));
 assert.equal(response.status,403);assert.equal((await response.json()).code,'PLATFORM_OWNER_REQUIRED');
 assert.equal(state.writes.length,0);assert.equal(state.audit,0);
});
test('retired trial and expired workspace sessions cannot bypass the separate Platform Owner audience',async()=>{
 for (const [payload,changes] of [
   [{workspaceName:'New workspace',planId:'plan',trial:true},{role:'owner',memberRole:'owner'}],
   [{workspaceName:'New workspace',planId:'plan'},{role:'owner',memberRole:'owner',familyActive:false}],
 ]) {
   reset(changes);
   const response=await onboarding.POST(req('/api/onboarding',payload));
   assert.equal(response.status,403);assert.equal(state.writes.length,0);assert.equal(state.audit,0);
 }
});
test('stale login timestamp admits settings and credential issuance side effects',async()=>{
 const operations=[()=>setting.PATCH(patch({name:'New workspace'})),()=>keys.POST(req('/api/odoo/keys',{name:'Printer key'}))];
 for(const operation of operations){reset({role:'owner',memberRole:'owner',staleProof:true});const response=await operation();
  assert.ok([200,201].includes(response.status));assert.equal(response.headers.get('X-Yaseir-Reauthentication'),null);assert.equal(state.writes.length,1);}
});
test('actual onboarding route rejects suspended Tenant before pending subscription or workspace write',async()=>{
 reset({role:'owner',memberRole:'owner',tenantActive:false});const response=await onboarding.POST(req('/api/onboarding',{workspaceName:'New workspace',planId:'plan'}));assert.equal(response.status,403);assert.equal(state.writes.length,0);assert.equal(state.audit,0);
});
