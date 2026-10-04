import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

async function actual(file, globals={}, select=s=>s) {
  const source=select(await readFile(file,'utf8'));
  const context=vm.createContext({ console, Date, Set, Map, WeakMap, Promise, Response, Request, URL, ...globals });
  const module=new vm.SourceTextModule(stripTypeScriptTypes(source,{mode:'transform'}),{context});
  await module.link(()=>{throw new Error('Unexpected external dependency');});
  await module.evaluate();
  return module.namespace;
}
const sessionFile='src/lib/session-config.ts';
function response(status,body) {return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});}

test('workspace admission refreshes the Manager path and shares concurrent checks',async()=>{
  const calls=[];
  const api=await actual(sessionFile,{fetch:async(path)=>{calls.push(path);return path.endsWith('/me')?response(200,{kind:'manager',exp:Math.floor(Date.now()/1000)+20}):response(200,{expiresAt:new Date(Date.now()+900000).toISOString()});}});
  const results=await Promise.all([api.ensureCustomerSession(),api.ensureCustomerSession()]);
  assert.ok(results.every(r=>r.authenticated));
  assert.deepEqual(calls,['/api/auth/me','/api/auth/manager/refresh']);
});
test('expired Manager cookie cannot shadow a valid Customer refresh family',async()=>{
  const calls=[];
  const api=await actual(sessionFile,{fetch:async(path)=>{calls.push(path);return path.endsWith('/me')?response(401,{refreshKind:'manager'}):path.includes('/manager/')?response(401,{}):response(200,{expiresAt:new Date(Date.now()+900000).toISOString()});}});
  assert.equal((await api.ensureCustomerSession()).authenticated,true);
  assert.deepEqual(calls,['/api/auth/me','/api/auth/manager/refresh','/api/auth/refresh']);
});
test('temporary session failure is not treated as a logout or retried mutation',async()=>{
  const calls=[];
  const api=await actual(sessionFile,{fetch:async(path)=>{calls.push(path);return response(503,{});}});
  await assert.rejects(api.ensureCustomerSession(),/temporarily unavailable/);
  assert.deepEqual(calls,['/api/auth/me']);
});

function fixture() {
  const tables={};
  for(const name of ['agents','printers','printJobs','printJobReceipts','apiKeys','discoveredDevices','discoverySessions']) tables[name]=new Proxy({name},{get:(o,k)=>k==='name'?o.name:{field:k}});
  const rows={agents:[{id:'a',tenantId:'t',status:'online',lifecycle:'active'},{id:'foreign',tenantId:'other'}],printers:[{id:'p',agentId:'a',tenantId:'t'},{id:'f',agentId:'foreign',tenantId:'other'}],printJobs:[],printJobReceipts:[],apiKeys:[{id:'key',tenantId:'t',revokedAt:null}],discoveredDevices:[],discoverySessions:[]};
  const events=[],locks=[];
  const eq=(column,value)=>row=>row[column.field]===value;
  const and=(...tests)=>row=>tests.filter(Boolean).every(fn=>fn(row));
  const or=(...tests)=>row=>tests.some(fn=>fn(row));
  const inArray=(column,values)=>row=>values.includes(row[column.field]);
  const sql=(strings,...values)=>{
    const text=strings.join('?');
    if(text.includes("NOT LIKE 'deleted:%'"))return row=>!String(row.hashedKey??'').startsWith('deleted:');
    return {text,values};
  };
  const tx={
    execute:async(query)=>{locks.push(query.text);return {rows:query.text.startsWith('SELECT id FROM agents')?rows.agents.filter(r=>r.id===query.values[0]&&r.tenantId===query.values[1]):[]};},
    select:()=>({from(table){let predicate=()=>true,limit=Infinity;const chain={where(p){predicate=p;return chain;},limit(n){limit=n;return chain;},async for(){return rows[table.name].filter(predicate).slice(0,limit).map(r=>({...r}));}};return chain;}}),
    insert:table=>({async values(row){rows[table.name].push({...row});}}),
    delete:table=>({async where(predicate){rows[table.name]=rows[table.name].filter(r=>!predicate(r));}}),
    update:table=>({set(values){let affected=[];return {where(predicate){affected=rows[table.name].filter(predicate);for(const row of affected) Object.assign(row,values);return {async returning(){return affected.map(r=>({id:r.id}));}};}};}}),
  };
  let claims={tenantId:'t',userId:'user',role:'owner'};
  const globals={...tables,sql,eq,and,or,inArray,createHash,db:{async transaction(fn){const before=structuredClone(rows),eventCount=events.length;try{return await fn(tx);}catch(e){Object.assign(rows,before);events.length=eventCount;throw e;}}},
    requireManager:async()=>{if(!claims)throw new ActionError('expired',401);return claims;},validateWorkspaceManager:async()=>claims,
    requireManagerPermission:()=>{if(claims?.role==='viewer')throw Object.assign(new Error('denied'),{status:403,code:'FORBIDDEN'});},
    requireActiveTenantInTransaction:async()=>{},getServerLocale:async()=> 'en',makeT:()=>key=>key,
    isTerminal:status=>['success','failed','expired'].includes(status),idempotencyDigest:input=>createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    revalidatePath:()=>{},writeAuditEvent:async event=>events.push(event),logError:()=>{},ActionError,
    NextResponse:{json:(body,opts)=>response(opts?.status??200,body)},
  };
  return {rows,events,locks,globals,setClaims:value=>{claims=value;}};
}
class ActionError extends Error {constructor(message,status){super(message);this.status=status;}}
async function deletion(f) {return actual('src/app/actions.ts',f.globals,s=>s.slice(s.indexOf('export async function deleteAgent('),s.indexOf('export async function createPrintJob(')));}
function job(id,status='queued') {return {id,tenantId:'t',agentId:'a',printerId:'p',apiKeyId:'key',status,idempotencyKey:`op-${id}`,payload:{type:'raw',protocol:'raw',data:'aA=='},createdAt:new Date(0),updatedAt:new Date(0)};}

test('online Agent deletion removes printers and retains terminal/uncertain operation receipts',async()=>{
  const f=fixture();f.rows.printJobs.push(job('success','success'),{...job('printing','printing'),deliveredAt:new Date()},job('queued'));
  const api=await deletion(f);assert.equal((await api.deleteAgent('a')).ok,true);
  assert.deepEqual(f.rows.agents.map(r=>r.id),['foreign']);assert.deepEqual(f.rows.printers.map(r=>r.id),['f']);
  assert.equal(f.rows.printJobs.length,0);assert.equal(f.rows.printJobReceipts.length,3);
  assert.equal(f.rows.printJobReceipts.find(r=>r.id==='success').status,'success');
  assert.match(f.rows.printJobReceipts.find(r=>r.id==='printing').error,/^UNKNOWN_PARTIAL_DELIVERY/);
  assert.match(f.rows.printJobReceipts.find(r=>r.id==='queued').error,/^AGENT_DELETED/);
  assert.ok(f.rows.printJobReceipts.every(r=>r.idempotencyKey&&/^[a-f0-9]{64}$/.test(r.fingerprint)));
  assert.equal(f.events[0].metadata.archivedJobs,3);
  assert.ok(f.locks.at(-1).includes('pg_notify'));
});
test('deletion batches history and forbids foreign-tenant resource deletion',async()=>{
  const f=fixture();for(let i=0;i<205;i++)f.rows.printJobs.push(job(String(i),'success'));
  const api=await deletion(f);await assert.rejects(api.deleteAgent('foreign'),e=>e.status===404);
  assert.equal(f.rows.printJobs.length,205);
  await api.deleteAgent('a');assert.equal(f.rows.printJobReceipts.length,205);assert.equal(f.rows.printJobs.length,0);
});
test('Agent deletion rolls back runtime and receipt writes when audit fails',async()=>{
  const f=fixture();f.rows.printJobs.push(job('j'));f.globals.writeAuditEvent=async()=>{throw new Error('audit unavailable');};
  const api=await deletion(f);await assert.rejects(api.deleteAgent('a'),/audit unavailable/);
  assert.equal(f.rows.agents.length,2);assert.equal(f.rows.printJobs.length,1);assert.equal(f.rows.printJobReceipts.length,0);
});
test('permanent active key deletion retains accepted work and key/job audit attribution',async()=>{
  const f=fixture();f.rows.printJobs.push(job('j','printing'));
  const api=await actual('src/app/api/odoo/keys/route.ts',f.globals,s=>s.slice(s.indexOf('export async function DELETE')));
  const result=await api.DELETE(new Request('https://gateway/api/odoo/keys',{method:'DELETE',body:JSON.stringify({id:'key',remove:true})}));
  assert.equal(result.status,200);assert.equal(f.rows.apiKeys.length,1);
  assert.equal(f.rows.apiKeys[0].hashedKey,'deleted:key');assert.equal(f.rows.apiKeys[0].odooEnabled,false);assert.equal(f.rows.apiKeys[0].readOnlyUntil,null);
  assert.equal(f.rows.printJobs[0].status,'printing');assert.equal(f.rows.printJobs[0].apiKeyId,'key');
  assert.equal(f.events[0].resourceId,'key');assert.equal(f.events[0].metadata.credentialErased,true);
  const repeat=await api.DELETE(new Request('https://gateway/api/odoo/keys',{method:'DELETE',body:JSON.stringify({id:'key',remove:true})}));assert.equal(repeat.status,404);
});
test('permanent key removal remains tenant scoped and rolls back on audit failure',async()=>{
  const f=fixture();f.rows.apiKeys[0].tenantId='other';
  const api=await actual('src/app/api/odoo/keys/route.ts',f.globals,s=>s.slice(s.indexOf('export async function DELETE')));
  const request=()=>new Request('https://gateway/api/odoo/keys',{method:'DELETE',body:JSON.stringify({id:'key',remove:true})});
  assert.equal((await api.DELETE(request())).status,404);assert.equal(f.rows.apiKeys.length,1);
  f.rows.apiKeys[0].tenantId='t';f.rows.printJobs.push(job('j'));f.globals.writeAuditEvent=async()=>{throw new Error('audit unavailable');};
  const other=await actual('src/app/api/odoo/keys/route.ts',f.globals,s=>s.slice(s.indexOf('export async function DELETE')));
  await assert.rejects(other.DELETE(request()),/audit unavailable/);assert.equal(f.rows.apiKeys.length,1);assert.equal(f.rows.printJobs[0].apiKeyId,'key');
});
test('Dashboard expected failures cross the action boundary as explicit data',async()=>{
  const api=await actual('src/app/actions.ts',{ActionError,logError:()=>{},getDashboardState:async()=>{throw new ActionError('expired',401);},getDashboardJobs:async()=>{throw Object.assign(new Error('denied'),{status:403,code:'FORBIDDEN'});},deleteAgent:async()=>{throw new Error('secret driver details');}},s=>s.slice(s.indexOf('async function dashboardResult')));
  const auth=await api.getDashboardStateResult();assert.equal(auth.status,401);assert.equal(auth.ok,false);
  const denial=await api.getDashboardJobsResult();assert.equal(denial.code,'FORBIDDEN');
  const failure=await api.deleteAgentResult('a');assert.equal(failure.status,500);assert.equal(failure.error,null);assert.ok(!JSON.stringify(failure).includes('secret'));
});

async function odooSave(changes,{removeKey=false,navigate=false}={}) {
  const calls=[];let controller;
  class Record {constructor(){this.resModel='print_gateway.gateway_config';this.resId=7;this.data={gateway_api_key:false};}
    async _save(){await controller.onRecordSaved(this,changes);calls.push('core-snapshot');this.data={gateway_api_key:removeKey?false:'encrypted',gateway_sync_state:'not_configured'};return true;}}
  class FormController {async onRecordSaved() {}}
  const patch=(prototype,extension)=>{Object.setPrototypeOf(extension,Object.create(Object.getPrototypeOf(prototype),Object.getOwnPropertyDescriptors(prototype)));Object.defineProperties(prototype,Object.getOwnPropertyDescriptors(extension));};
  const context=vm.createContext({WeakMap});
  const common=new vm.SyntheticModule(['Record','FormController','patch'],function(){this.setExport('Record',Record);this.setExport('FormController',FormController);this.setExport('patch',patch);},{context});
  const source=await readFile('odoo_addons/print_gateway/static/src/js/gateway_config_auto_sync.js','utf8');
  const module=new vm.SourceTextModule(source,{context});await module.link(()=>common);await module.evaluate();
  const record=new Record();controller=new FormController();controller.model={root:record,load:async()=>{calls.push('reload');controller.model.root={...record,data:{gateway_sync_state:'active'}};}};
  controller.orm={call:async(_model,method,ids)=>{calls.push(method);assert.equal(ids[0][0],7);if(navigate)controller.model.root={resModel:'different',resId:8};return {};}};controller.actionService={doAction:async()=>{}};
  await record._save();return {calls,controller};
}
test('Odoo first key save reloads connected state after the stale core snapshot',async()=>{
  const {calls,controller}=await odooSave({gateway_api_key:'new'});
  assert.deepEqual(calls,['core-snapshot','action_test_connection','reload']);assert.equal(controller.model.root.data.gateway_sync_state,'active');
});
test('Odoo URL/toggle changes synchronize and key removal still reloads',async()=>{
  assert.deepEqual((await odooSave({gateway_url:'new'})).calls,['core-snapshot','action_test_connection','reload']);
  assert.deepEqual((await odooSave({enabled:true})).calls,['core-snapshot','action_retry_enabled_sync','reload']);
  assert.deepEqual((await odooSave({gateway_api_key:false},{removeKey:true})).calls,['core-snapshot','reload']);
});
test('Odoo synchronization cannot navigate back to an old form',async()=>{
  assert.deepEqual((await odooSave({gateway_api_key:'new'},{navigate:true})).calls,['core-snapshot','action_test_connection']);
});


test('workspace probe accepts Manager sessions without exposing credentials',async()=>{
  const api=await actual('src/app/api/auth/me/route.ts',{validateWorkspaceManager:async()=>({tenantId:'t',userId:'u',role:'owner',kind:'manager',exp:1000}),managerPermissions:()=>['agents.retire'],NextResponse:{json:(body,opts)=>new Response(JSON.stringify(body),{status:opts?.status??200,headers:opts?.headers})}},s=>s.slice(s.indexOf('export async function GET')));
  const result=await api.GET(new Request('https://gateway/api/auth/me'));
  assert.equal(result.status,200);assert.equal(result.headers.get('cache-control'),'no-store');
  const body=await result.json();assert.equal(body.kind,'manager');assert.deepEqual(body.permissions,['agents.retire']);assert.equal(body.authenticated,true);
  assert.equal(body.accessToken,undefined);assert.equal(body.refreshToken,undefined);
});
test('expired workspace probe provides only refresh routing and team reads return 401',async()=>{
  const globals={validateWorkspaceManager:async()=>null,managerPermissions:()=>[],NextResponse:{json:(body,opts)=>response(opts?.status??200,body)}};
  const probe=await actual('src/app/api/auth/me/route.ts',globals,s=>s.slice(s.indexOf('export async function GET')));
  const result=await probe.GET(new Request('https://gateway/api/auth/me',{headers:{cookie:'mgr_session=expired'}}));
  assert.equal(result.status,401);assert.equal((await result.json()).refreshKind,'manager');
  for(const resource of ['members','invitations']) {
    const api=await actual(`src/app/api/team/${resource}/route.ts`,globals,s=>s.slice(s.indexOf('export async function GET'),s.indexOf('export async function '+(resource==='members'?'PATCH':'POST'))));
    assert.equal((await api.GET(new Request(`https://gateway/api/team/${resource}`))).status,401);
  }
});

test('Odoo print admission rechecks the live credential before consuming plan credit',async()=>{
  const calls=[];
  const tx={execute:async query=>{
    calls.push(query.text);
    if(query.text.includes('clock_timestamp() AS now'))return {rows:[{now:new Date()}]};
    if(query.text.includes('FROM agents a'))return {rows:[{printer_agent_id:'a',tenant_lifecycle:'active',printer_lifecycle:'active',agent_lifecycle:'active'}]};
    return {rows:[]};
  }};
  const api=await actual('src/lib/print-job-service.ts',{
    db:{transaction:fn=>fn(tx)},sql:(strings,...values)=>({text:strings.join('?'),values}),
    isVirtualPrinterRecord:()=>false,isPrinterStatusExecutable:()=>true,validatePayloadForPrinter:()=>({ok:true}),
    enforceTenantJobEntitlements:async()=>calls.push('billing-locked'),reserveTenantPrintCredit:async()=>calls.push('credit-reserved'),
    PrintJobInputError:class extends Error{constructor(message,code,status){super(message);this.code=code;this.status=status;}},
  },s=>s.slice(s.indexOf('async function insertQueuedJobAtomically'),s.indexOf('export async function createPrintJobForPrinter')).replace('async function insertQueuedJobAtomically','export async function insertQueuedJobAtomically'));
  await assert.rejects(api.insertQueuedJobAtomically({jobId:'j',printerId:'p',agentId:'a',tenantId:'t',validatedPayload:{type:'raw',protocol:'raw'},requestedBy:'odoo',rateLimitKeyId:'removed'}),error=>error.status===401&&error.code==='UNAUTHORIZED');
  const check=calls.findIndex(s=>s.includes('FROM api_keys'));assert.ok(check>calls.indexOf('billing-locked'));
  assert.match(calls[check],/revoked_at IS NULL/);assert.match(calls[check],/odoo_enabled = TRUE/);assert.match(calls[check],/FOR UPDATE/);
  assert.ok(!calls.includes('credit-reserved'));
});

test('an activation request authenticated before key removal cannot revive that credential',async()=>{
  const guards=[];
  const apiKeys=new Proxy({}, {get:(_target,field)=>({field})});
  const tx={update:()=>({set:()=>({where:predicate=>({returning:async()=>[]})})})};
  const api=await actual('src/app/api/odoo/configuration/route.ts',{
    apiKeys,validateOdooKey:async()=>({id:'key',tenantId:'t',hashedKey:'original',readOnly:false}),
    db:{transaction:fn=>fn(tx),query:{apiKeys:{findFirst:async()=>undefined}}},
    sql:(strings,...values)=>{guards.push([strings.join('?'),values]);return {};},
    and:(...values)=>values,eq:(column,value)=>{guards.push([column.field,value]);return {};},lt:()=>({}),
    isTenantBillingError:()=>false,requireTenantBillingAccess:async()=>{},
    NextResponse:{json:(body,opts)=>response(opts?.status??200,body)},
  },s=>s.slice(s.indexOf('export async function PATCH')));
  const result=await api.PATCH(new Request('https://gateway/api/odoo/configuration',{method:'PATCH',body:JSON.stringify({enabled:false,revision:1000})}));
  assert.equal(result.status,401);assert.equal((await result.json()).code,'UNAUTHORIZED');
  assert.ok(guards.some(([field,value])=>field==='hashedKey'&&value==='original'));
  assert.ok(guards.some(([text])=>text.includes('IS NULL')));
});
