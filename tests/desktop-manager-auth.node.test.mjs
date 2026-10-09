// Runnable Node-stdlib behavioral regression for the actual IPC + shell
// declarations. Network, React hooks and native command are explicit seams.
// No installed Windows/Tauri/Gateway authorization is implied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const sourceRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=x=>fs.readFileSync(path.join(sourceRoot,x),'utf8');
const ipc=read('src/desktop/lib/ipc.ts');
const shell=read('src/desktop/main.tsx');
const rust=read('src-tauri/src/commands.rs');
function slice(source,start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a,`live source ${start}`);return source.slice(a,b);}
function js(src){return ts.transpileModule(src.replace(/\bexport (async function|function|type|interface)/g,'$1'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None,jsx:ts.JsxEmit.ReactJSX}}).outputText;}
const meSrc=slice(ipc,'function decodeManagerMe(', 'async function fetchWithTimeout(');
const loginSrc=slice(ipc,'export async function loginManager(', 'const refreshFlights');
const getSrc=slice(ipc,'export async function getManagerSession(', 'export function onManagerAuthChanged(');
const gatewaySrc=slice(ipc,'async function gatewayRequest(', 'async function gatewayConsoleRequest(');
const shellSrc=slice(shell,'  // A Gateway probe proves connectivity', '  const savedOriginMatches');
const roles=['owner','admin','operator','viewer','integration_admin','billing_admin'];
const origin='https://gw.example.com';
const sampleMe=(overrides={})=>({authenticated:true,exp:Math.floor(Date.now()/1000)+900,tenantId:'workspace-1',userId:'user-1',role:'operator',...overrides});
function makeIpc({send=async(_base,path)=>({status:200,body:JSON.stringify(sampleMe())}),native=false}={}) {
  const events=[];const calls=[];const invokes=[];
  const context=vm.createContext({
    MANAGER_ROLES:roles,MANAGER_AUTH_EVENT:'changed',browserManagerAuthenticated:false,
    normalizeGatewayUrl:value=>value,isTauri:native,
    gatewayRequest:async(...args)=>{calls.push(args);return send(...args);},
    window:{dispatchEvent:e=>events.push(e.type)},Event:class Event{constructor(type){this.type=type}},
    invoke:async(...args)=>{invokes.push(args);return {status:200,body:JSON.stringify(sampleMe())}},
  });
  vm.runInContext(js(`${meSrc}\n${loginSrc}\n${getSrc}\nglobalThis.auth={getManagerSession,loginManager,logoutManager,decodeManagerMe};`),context);
  return {context,events,calls,invokes,api:context.auth};
}
function makeShell({account, currentOrigin=origin, getSession=async()=>sampleMe(), login, logout}={}) {
  const snapshots=[];const effects=[];const navigation=[];const messages=[];
  const ctx=vm.createContext({
    savedGatewayUrl:origin,savedOriginRef:{current:currentOrigin},
    useState:initial=>[typeof initial==='function'?initial():(initial?.status==='unconfigured'?account??initial:initial),next=>snapshots.push(next)],
    // The isolated shell fragment starts after the clock hook in production.
    nowMs: Date.now(),
    useRef:initial=>({current:initial}),useCallback:fn=>fn,useEffect:fn=>effects.push(fn),
    onManagerAuthChanged:()=>()=>{},getManagerSession:getSession,
    loginManager:login??(async()=>sampleMe()),logoutManager:logout??(async()=>{}),
    setShowAdd:()=>{},setEditingPrinter:()=>{},setMsg:v=>messages.push(v),
    navigate:v=>navigation.push(v),t:v=>v,
  });
  vm.runInContext(js(`${shellSrc}\nglobalThis.authShell={probe:probeManagerAccount,login:managerLogin,logout:managerLogout,getCanTest:()=>managerCanTest,getCanManage:()=>managerCanManage,getActor:()=>managerActorScope,requestAdd:requestAddPrinter};`),ctx);
  return {ctx,api:ctx.authShell,snapshots,effects,navigation,messages};
}
test('actual /me decoder rejects invalid identity, role, expiry, tenant and user',()=>{
  const {api}=makeIpc();
  for(const override of [{tenantId:''},{exp:'2026'},{exp:NaN},{role:'superuser'}, {role:'root'}, {userId:42},{authenticated:false}]){
    assert.throws(()=>api.decodeManagerMe(JSON.stringify(sampleMe(override))));
  }
  assert.equal(api.decodeManagerMe(JSON.stringify(sampleMe())).tenantId,'workspace-1');
  assert.equal(api.decodeManagerMe(JSON.stringify(sampleMe())).role,'operator');
});
test('actual /me IPC requires 2xx with decoded identity; 401/403 deny; 5xx is unavailable',async()=>{
  for(const status of [401,403]){
    const {api}=makeIpc({send:async()=>({status,body:JSON.stringify({error:'no'})})});
    assert.equal((await api.getManagerSession(origin)).authenticated,false);
  }
  const server=makeIpc({send:async()=>({status:503,body:'unavailable'})});
  await assert.rejects(server.api.getManagerSession(origin),e=>e.status===503);
  const bad=makeIpc({send:async()=>({status:200,body:JSON.stringify(sampleMe({role:'superuser'}))})});
  await assert.rejects(bad.api.getManagerSession(origin),/invalid/);
  const ok=makeIpc();const value=await ok.api.getManagerSession(origin);
  assert.equal(value.authenticated,true);assert.equal(value.role,'operator');
  assert.ok(Date.parse(value.expiresAt)>Date.now());
});
test('actual login only dispatches signed-in marker after identity probe, never after false 2xx',async()=>{
  const denied=makeIpc({send:async(_base,path)=>path.endsWith('/login')?{status:200,body:JSON.stringify({ok:true})}:{status:401,body:'{}'}});
  await assert.rejects(denied.api.loginManager(origin,'user@sample.tld','password'),/authorized session/);
  assert.equal(denied.context.browserManagerAuthenticated,false);
  assert.deepEqual(denied.events,[]);
  const good=makeIpc({send:async(_base,path)=>path.endsWith('/login')?{status:200,body:JSON.stringify({ok:true})}:{status:200,body:JSON.stringify(sampleMe())}});
  const status=await good.api.loginManager(origin,'user@sample.tld','password');
  assert.equal(status.role,'operator');assert.equal(good.context.browserManagerAuthenticated,true);
  assert.deepEqual(good.events,['changed']);
  assert.equal(good.calls[0][1],'/api/auth/manager/login');
  assert.equal(good.calls[1][1],'/api/auth/manager/me');
  assert.equal(good.calls[0][3]['X-Odoo-Print-Desktop'],'1');
});
test('live native gateway request includes immutable expected_origin and no bearer from renderer',async()=>{
  const seen=[];const ctx=vm.createContext({
    normalizeGatewayUrl:value=>value,isTauri:true,
    invoke:async(name,params)=>{seen.push({name,params});return {status:200,body:'{}'}},
  });
  vm.runInContext(js(`${gatewaySrc}\nglobalThis.gateway=gatewayRequest;`),ctx);
  await ctx.gateway(origin,'/api/auth/manager/me');
  assert.equal(seen[0].name,'gateway_request');
  assert.equal(seen[0].params.args.expected_origin,origin);
  assert.equal(seen[0].params.args.body,null);
  assert.ok(!Object.keys(seen[0].params.args.headers).some(x=>x.toLowerCase()==='authorization'));
  assert.match(rust,/let expected_origin = normalize_gateway_url\(&args.expected_origin\)/);
  assert.match(rust,/if expected_origin != origin.as_str\(\).trim_end_matches\('\/'\)/);
});
test('live shell role checks match Gateway test/manage RBAC and expire safely',()=>{
  const cases=[['owner',true,true],['admin',true,true],['operator',true,false],['viewer',false,false],['integration_admin',false,false],['billing_admin',false,false]];
  for(const [role,canTest,canManage] of cases){
    const session={authenticated:true,tenantId:'workspace-1',userId:'user-1',role,expiresAt:new Date(Date.now()+60_000).toISOString()};
    const {api}=makeShell({account:{origin,status:'authenticated',session}});
    assert.equal(api.getCanTest(),canTest,role);assert.equal(api.getCanManage(),canManage,role);
    assert.equal(api.getActor(),`workspace-1:user-1:${role}`);
  }
  const expired=makeShell({account:{origin,status:'authenticated',session:{authenticated:true,tenantId:'workspace-1',role:'owner',expiresAt:'2000-01-01T00:00:00Z'}}});
  assert.equal(expired.api.getCanTest(),false);assert.equal(expired.api.getCanManage(),false);
  const mismatch=makeShell({account:{origin:'https://another.example',status:'authenticated',session:{authenticated:true,tenantId:'workspace-1',role:'owner',expiresAt:new Date(Date.now()+60_000).toISOString()}}});
  assert.equal(mismatch.api.getCanTest(),false);
});
test('live shell refuses Manager config before sign-in instead of opening dialog',()=>{
  const shell=makeShell();
  shell.api.requestAdd(true);
  assert.deepEqual(shell.navigation,['settings']);
  assert.equal(shell.messages[0].text,'desktop.manager.requireSignIn');
});
test('live shell drops stale or wrong-origin session probes',async()=>{
  const resolver=[];const shell=makeShell({getSession:()=>new Promise(resolve=>resolver.push(resolve))});
  const older=shell.api.probe(origin);
  const newer=shell.api.probe(origin);
  assert.equal(resolver.length,2);
  resolver[1]({authenticated:true,tenantId:'work-new',role:'admin',expiresAt:new Date(Date.now()+60_000).toISOString()});
  await newer;
  resolver[0]({authenticated:true,tenantId:'old',role:'owner',expiresAt:new Date(Date.now()+60_000).toISOString()});
  await older;
  assert.equal(shell.snapshots.at(-1).session.tenantId,'work-new');
  assert.ok(!shell.snapshots.some(x=>x.session?.tenantId==='old'));
  const wrong=shell.api.probe(origin);
  shell.ctx.savedOriginRef.current='https://new.example.com';
  resolver[2]({authenticated:true,tenantId:'stale-origin',role:'owner'});
  await wrong;
  assert.ok(!shell.snapshots.some(x=>x.session?.tenantId==='stale-origin'));
});
test('live shell shows unavailable on failed /me without promoting role',async()=>{
  const shell=makeShell({getSession:async()=>{throw new Error('network')}});
  await shell.api.probe(origin);
  assert.equal(shell.snapshots.at(-1).status,'unavailable');
  assert.equal(shell.snapshots.at(-1).session,null);
});
test('live shell login ignores identity response for changed origin, successful logout clears actor',async()=>{
  let resolveLogin;
  const loginPromise=new Promise(r=>{resolveLogin=r});
  const changing=makeShell({login:()=>loginPromise});
  const pending=changing.api.login('user@sample.tld','private');
  changing.ctx.savedOriginRef.current='https://new.example.com';
  resolveLogin({authenticated:true,tenantId:'tenant-old',role:'owner'});
  await assert.rejects(pending,/session changed/);
  assert.ok(!changing.snapshots.some(x=>x.status==='authenticated'));
  const stable=makeShell({login:async()=>({authenticated:true,tenantId:'tenant-good',role:'admin',expiresAt:new Date(Date.now()+60_000).toISOString()})});
  await stable.api.login('user@sample.tld','private');
  assert.equal(stable.snapshots.at(-1).session.tenantId,'tenant-good');
  await stable.api.logout();
  assert.equal(stable.snapshots.at(-1).status,'signed-out');
});
