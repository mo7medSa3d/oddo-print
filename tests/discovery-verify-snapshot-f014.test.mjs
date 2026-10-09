// Execute production discovery verify handler and observation-hash helper directly.
// VM stubs replace HTTP identity and the transaction store, NOT the handler policy.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
const require=createRequire(import.meta.url);
let ts; try{ts=require('typescript')}catch{ts=require(join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'typescript'))}
const transpile=(path)=>ts.transpileModule(readFileSync('src/'+path,'utf8'),{fileName:path,compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const ctx=vm.createContext({console,Request,Response,Headers,Error,Set,Map,Number,Object,JSON,String,Array});
const mk=(exports)=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [name,value] of Object.entries(exports))this.setExport(name,value);},{context:ctx});
const sql=(parts,...params)=>({parts,params});sql.join=(items,sep)=>({items,sep});
const render=(v)=>v?.parts?v.parts.map((s,i)=>s+(i<v.params.length?render(v.params[i]):'')).join(''):v?.items?v.items.map(render).join(render(v.sep)):String(v);
const eq=(lhs,rhs)=>({op:'eq',lhs,rhs});const and=(...terms)=>({op:'and',terms});
const matches=(predicate,row)=>!predicate||predicate.op==='and'?(!predicate||predicate.terms.every(p=>matches(p,row))):predicate.op==='eq'?(row[predicate.lhs]===predicate.rhs):true;
const dr=mk({sql,eq,and});
const agent={id:'agent',tenantId:'tenant',lifecycle:'active'};
let state;
const baseRow=()=>({id:'dev',tenantId:'tenant',agentId:'agent',discoveryId:'scan1',identityKey:'printer-stable',protocol:'ipp',ipAddress:'192.168.10.50',port:631,uri:'ipp://192.168.10.50/ipp/print',spoolerName:null,deviceName:'Office printer',manufacturer:null,model:'M1',hostname:null,serialNumber:null,macAddress:null,transport:'ipp',deviceClass:'laser',capabilities:{print:{color:true}},verification:'candidate',candidateStatus:'discovered'});
function reset(changes={}){state={row:baseRow(),managerRole:'admin',memberRole:'admin',tenantActive:true,agentActive:true,familyActive:true,legacyActive:true,events:[],writes:0,preflight:undefined,...changes};}
const tx={
  execute:async(q)=>{
    const text=render(q);state.events.push(text);
    if(/FROM agents/i.test(text))return {rows:state.agentActive?[{id:'agent',lifecycle:'active'}]:[{id:'agent',lifecycle:'retired'}]};
    if(/FROM discovered_devices/i.test(text))return {rows:state.row?[{...state.row,candidate_status:state.row.candidateStatus}]:[]};
    if(/FROM tenants/i.test(text))return {rows:[{id:'tenant',lifecycle:state.tenantActive?'active':'suspended'}]};
    if(/FROM users/i.test(text))return {rows:[{id:'actor'}]};
    if(/pg_advisory_xact_lock/i.test(text))return {rows:[{}]};
    if(/refresh_tokens/i.test(text))return {rows:state.familyActive?[{id:'family'}]:[]};
    if(/manager_sessions/i.test(text))return {rows:state.legacyActive?[{id:'session'}]:[]};
    throw Error('Unexpected SQL '+text);
  },
  query:{tenantUsers:{findFirst:async()=>state.memberRole?{role:state.memberRole}:null},discoveredDevices:{findFirst:async({where})=>matches(where,state.row)?{...state.row}:null}},
  update:()=>({set:(data)=>({where:()=>({returning:async()=>{if(!state.row || state.row.candidateStatus!=='discovered')return [];state.writes++;state.row={...state.row,...data,candidateStatus:'verified',verification:'verified'};return [{id:'dev'}];}})})}),
};
const db={query:{agents:{findFirst:async()=>{state.preflight?.();return state.agentActive?agent:null}},discoverySessions:{findFirst:async()=>({id:'scan1',agentId:'agent',tenantId:'tenant'})},discoveredDevices:{findFirst:async()=>state.row?{...state.row}:null,findMany:async()=>state.row?[{...state.row}]:[]}},transaction:async(fn)=>fn(tx),update:()=>tx.update()};
const schema=mk({agents:{id:'id',tenantId:'tenantId'},discoveredDevices:{id:'id',agentId:'agentId',tenantId:'tenantId',candidateStatus:'candidateStatus',discoveryId:'discoveryId'},discoverySessions:{id:'id',agentId:'agentId',tenantId:'tenantId'},tenantUsers:{userId:'userId',tenantId:'tenantId'}});
const auth=new vm.SourceTextModule(transpile('lib/authorization.ts'),{context:ctx});await auth.link(()=>{throw Error('auth imports unexpected')});await auth.evaluate();
const guard=new vm.SourceTextModule(transpile('lib/manager-mutation-authorization.ts'),{context:ctx});await guard.link(n=>n==='drizzle-orm'?dr:n.endsWith('db/schema')?schema:auth);await guard.evaluate();
class TestTenantSuspendedError extends Error {}
class TestTenantDeletedError extends Error {}
const dep={
 'next/server':mk({NextResponse:{json:(value,{status=200}={})=>Response.json(value,{status})}}),
 'drizzle-orm':dr,
 'node:crypto':mk({createHash}),
 '/lib/manager-auth':mk({validateWorkspaceManager:async()=>({tenantId:'tenant',userId:'actor',role:state.managerRole,jti:'jti',familyId:'family',exp:1900000000,kind:'manager'})}),
 '/lib/tenant-guard':mk({TenantSuspendedError:TestTenantSuspendedError,TenantDeletedError:TestTenantDeletedError,requireActiveTenantInTransaction:async(t,tenantId)=>{const rows=await t.execute(sql`SELECT lifecycle FROM tenants WHERE id = ${tenantId} FOR SHARE`);if(rows.rows[0]?.lifecycle!=='active')throw new TestTenantSuspendedError('TENANT_SUSPENDED')}}),
 '/db':mk({db}),
 '/db/schema':schema,
};
async function load(filename){const mod=new vm.SourceTextModule(transpile(filename),{context:ctx});await mod.link((n)=>{if(n.endsWith('/lib/authorization'))return auth;if(n.endsWith('/lib/manager-mutation-authorization'))return guard;for(const [k,value] of Object.entries(dep))if(n===k||n.endsWith(k))return value;throw Error('Unexpected import '+n+' in '+filename)});await mod.evaluate();return mod.namespace;}
let observation;
if(readFileSync('src/app/api/agents/[id]/discovered-printers/[deviceId]/verify/route.ts','utf8').includes('discovery-observation')) {
  observation=await load('lib/discovery-observation.ts');
  dep['/lib/discovery-observation']=mk(observation);
}
const handler=await load('app/api/agents/[id]/discovered-printers/[deviceId]/verify/route.ts');
const request=(fingerprint)=>new Request('http://localhost/api/agents/agent/discovered-printers/dev/verify',{method:'POST',headers:fingerprint?{'If-Match':`"${fingerprint}"`}:{}});
const call=(fingerprint)=>handler.POST(request(fingerprint),{params:Promise.resolve({id:'agent',deviceId:'dev'})});
const fp=(device)=>observation?.discoveryObservationFingerprint(device)??'0123456789abcdef'.repeat(4);
test('approval of unchanged observation requires and accepts matching snapshot',async()=>{reset();const r=await call(fp(state.row));assert.equal(r.status,200);assert.equal(state.writes,1);assert.equal(state.row.verification,'verified');});
test('unversioned approval is rejected (no implicit approval of newest discovery)',async()=>{reset();const r=await call();assert.equal(r.status,428);assert.equal(state.writes,0);});
test('changed endpoint since operator snapshot cannot be approved',async()=>{reset();const selected=fp(state.row);state.row.ipAddress='192.168.10.99';state.row.uri='ipp://192.168.10.99/ipp/print';const r=await call(selected);assert.equal(r.status,409);assert.equal(state.writes,0);});
test('changed capabilities or effective spooler name requires reapproval',async()=>{reset();const selected=fp(state.row);state.row.capabilities={print:{color:false}};let r=await call(selected);assert.equal(r.status,409);assert.equal(state.writes,0);reset();const original=fp(state.row);state.row.spoolerName='new queue';r=await call(original);assert.equal(r.status,409);assert.equal(state.writes,0);});
test('same approved snapshot can be rechecked safely without second write',async()=>{reset();const selected=fp(state.row);assert.equal((await call(selected)).status,200);assert.equal((await call(selected)).status,200);assert.equal(state.writes,1);});
test('demotion during request is rejected by live authority guard',async()=>{reset({memberRole:'viewer'});const r=await call(fp(state.row));assert.equal(r.status,403);assert.equal(state.writes,0);});
test('revoked manager family refuses approval',async()=>{reset({familyActive:false});const r=await call(fp(state.row));assert.equal(r.status,403);assert.equal(state.writes,0);});
test('retired Agent and suspended Tenant cannot approve',async()=>{reset({agentActive:false});assert.notEqual((await call(fp(state.row))).status,200);reset({tenantActive:false});assert.notEqual((await call(fp(state.row))).status,200);assert.equal(state.writes,0);});
test('scope mismatch does not approve any candidate',async()=>{reset();state.row.tenantId='other';assert.notEqual((await call(fp(state.row))).status,200);assert.equal(state.writes,0);});

test('GET discovery exposes a matching fingerprint sourced from committed row',async()=>{
 reset();const endpoint=await load('app/api/agents/[id]/discovery/[discoveryId]/route.ts');
 const response=await endpoint.GET(new Request('http://localhost/api/agents/agent/discovery/scan1'),{params:Promise.resolve({id:'agent',discoveryId:'scan1'})});
 assert.equal(response.status,200);
 const data=await response.json();assert.equal(data.devices[0].observationFingerprint,fp(state.row));
 assert.equal((await call(data.devices[0].observationFingerprint)).status,200);
});
test('snapshot canonicalizes JSONB capabilities object key ordering and changes on destination change',()=>{
 reset();const hash=fp(state.row);state.row.capabilities={print:{color:true}};assert.equal(fp(state.row),hash);
 state.row.capabilities={z:1,a:{y:2,x:1}};const changed=fp(state.row);state.row.capabilities={a:{x:1,y:2},z:1};assert.equal(fp(state.row),changed);
 state.row.deviceName='Renamed spooler fallback';assert.notEqual(fp(state.row),changed);
});
