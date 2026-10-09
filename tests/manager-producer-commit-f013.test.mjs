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
const require = createRequire(import.meta.url);
let ts;try{ts=require('typescript')}catch{ts=require(join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'typescript'))}
const from=(file)=>ts.transpileModule(readFileSync('src/'+file,'utf8'),{fileName:file,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const ctx=vm.createContext({console,Set,Map,Error,Number,Object,Request,Response,URL,Headers,URLSearchParams});
const stub=(exports)=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v)},{context:ctx});
const sql=(parts,...params)=>({parts,params});sql.join=(items,sep)=>({items,sep});
const repr=(v)=>v?.parts?v.parts.map((p,i)=>p+(i<v.params.length?repr(v.params[i]):'')).join(''):v?.items?v.items.map(repr).join(repr(v.sep)):String(v);
const dr=stub({sql,and:(...args)=>args,eq:(...args)=>args,desc:(x)=>x});
let state;
const db={
 query:{tenants:{findFirst:async()=>({id:'tenant'})},plans:{findFirst:async()=>({id:'plan',stripePriceId:'price'})},tenantSubscriptions:{findFirst:async()=>null}},
 transaction:async(fn)=>fn(tx),
};
const tx={
 execute:async(q)=>{
  const text=repr(q);state.events.push(text);
  if(/FROM tenants/i.test(text))return {rows:[{id:'tenant',lifecycle:state.tenantActive?'active':'suspended'}]};
  if(/FROM users/i.test(text))return {rows:[{id:'actor'}]};
  if(/FROM tenant_subscriptions/i.test(text))return {rows:[]};
  if(/pg_advisory_xact_lock/i.test(text))return {rows:[{}]};
  if(/refresh_tokens/i.test(text))return {rows:state.familyActive?[{id:'token'}]:[]};
  if(/manager_sessions/i.test(text))return {rows:state.legacyActive?[{jti:'signed'}]:[]};
  throw Error('Unexpected tx.execute: '+text);
 },
 query:{tenantUsers:{findFirst:async()=>state.memberRole?{role:state.memberRole}:null},tenantSubscriptions:{findFirst:async()=>null}},
 update:()=>({set:(data)=>({where:async()=>{state.writes.push(data);return []}})}),
 insert:()=>({values:async(data)=>{state.writes.push(data)}}),
 select:()=>({from:()=>({where:()=>({for:async()=>[{id:'api-key'}]})})}),
};
const schema=stub({tenantUsers:{userId:'userId',tenantId:'tenantId'},users:{id:'id'},tenants:{id:'id',name:'name'},apiKeys:{id:'id',tenantId:'tenantId',hashedKey:'hashed_key',revokedAt:'revokedAt',odooEnabledRevision:'odooEnabledRevision'},plans:{id:'id',isActive:'isActive',isPublic:'isPublic'},tenantSubscriptions:{tenantId:'tenantId'}});
const auth=new vm.SourceTextModule(from('lib/authorization.ts'),{context:ctx});await auth.link(()=>{throw Error('unexpected authorization import')});await auth.evaluate();
const guard=new vm.SourceTextModule(from('lib/manager-mutation-authorization.ts'),{context:ctx});await guard.link((name)=>name==='drizzle-orm'?dr:name.endsWith('db/schema')?schema:auth);await guard.evaluate();
const deps={
 'next/server':stub({NextResponse:{json:(data,{status=200}={})=>Response.json(data,{status})}}),
 'drizzle-orm':dr,
};
const lib={
 '/lib/authorization':auth,
 '/lib/manager-mutation-authorization':guard,
 '/lib/manager-auth':stub({validateWorkspaceManager:async()=>{
  state.preflight?.();return {tenantId:'tenant',jti:'jti',exp:1900000000,role:state.role,userId:'actor',kind:'manager',familyId:state.legacy?undefined:'family'};
 }}),
 '/lib/tenant-guard':stub({requireActiveTenantInTransaction:async(t,tid)=>{
   const v=await t.execute(sql`SELECT lifecycle FROM tenants WHERE id = ${tid} FOR SHARE`);
   if(v.rows[0]?.lifecycle!=='active')throw Error('TENANT_SUSPENDED');return 'active';
 }}),
 '/lib/entitlements':stub({requireTenantBillingAccess:async(t,id)=>{state.events.push('billing entitlement '+id)},isTenantBillingError:()=>false}),
 '/lib/odoo-auth':stub({generateOdooApiKey:()=>({raw:'secret',hashed:'hash',id:'key1'})}),
 '/lib/audit':stub({writeAuditEvent:async()=>{state.audit++}}),
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
 reset({role:'owner',memberRole:'owner',familyActive:false});const response=await setting.PATCH(patch({name:'New workspace'}));assert.equal(response.status,403);assert.equal(state.writes.length,0);
});
test('actual Odoo credential route inserts only after matching live Manager authority',async()=>{
 reset();const response=await keys.POST(req('/api/odoo/keys',{name:'Printer key'}));assert.equal(response.status,201);assert.equal(state.writes.length,1);assert.equal(state.audit,1);
});
test('actual Odoo credential route refuses revoked family before issuing key',async()=>{
 reset({familyActive:false});const response=await keys.POST(req('/api/odoo/keys',{name:'Printer key'}));assert.equal(response.status,403);assert.equal(state.writes.length,0);assert.equal(state.audit,0);
});
test('actual Odoo credential route refuses demoted actor before issuing key',async()=>{
 reset({memberRole:'viewer'});const response=await keys.POST(req('/api/odoo/keys',{name:'Printer key'}));assert.equal(response.status,403);assert.equal(state.writes.length,0);
});
test('actual onboarding route protects trial and workspace name together',async()=>{
 reset({role:'owner',memberRole:'owner'});const response=await onboarding.POST(req('/api/onboarding',{workspaceName:'New workspace',planId:'plan',trial:true}));assert.equal(response.status,200);assert.equal(state.writes.length,2);assert.equal(state.audit,0);
});
test('actual onboarding route rejects stale session before trial or workspace write',async()=>{
 reset({role:'owner',memberRole:'owner',familyActive:false});const response=await onboarding.POST(req('/api/onboarding',{workspaceName:'New workspace',planId:'plan',trial:true}));assert.equal(response.status,403);assert.equal(state.writes.length,0);
});
test('actual onboarding route rejects suspended Tenant before trial or workspace write',async()=>{
 reset({role:'owner',memberRole:'owner',tenantActive:false});const response=await onboarding.POST(req('/api/onboarding',{workspaceName:'New workspace',planId:'plan',trial:true}));assert.equal(response.status,403);assert.equal(state.writes.length,0);
});
