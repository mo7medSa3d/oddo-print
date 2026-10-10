// Node-stdlib integration tests: live source functions, HTTP/React/IPC seams
// replaced explicitly. No claim of PostgreSQL, Windows or paper acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as model from '../src/shared/diagnostic-test.ts';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const dashboard = read('src/app/dashboard/dashboard-client.tsx');
const desktop = read('src/desktop/main.tsx');
const ipc = read('src/desktop/lib/ipc.ts');
const between = (source, start, end) => {
  const a = source.indexOf(start); const b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Production source range ${start}`);
  return source.slice(a,b);
};
const compile = source => ts.transpileModule(source, { compilerOptions: {
  target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.None, jsx:ts.JsxEmit.ReactJSX,
}}).outputText;
const sendSource = between(dashboard, 'async function sendGatewayTestPage(', '/* ---------- Local presentational helpers ---------- */');
const dashHandler = between(dashboard, '  const handleGatewayTestPrint = async', '  /**\n   * Reprint');
const desktopHandler = between(desktop, '  const handleTest = useCallback(', '  const startAgent = useCallback');
const ipcSource = between(ipc, 'export async function testGatewayPrinter(', 'export function cleanupLocalJobs');
function makeDashboard(send, { actor = 'tenant1:user1:owner' } = {}) {
  let serial=0;
  const messages=[]; const requests=[]; const busy=[];
  const ops = new model.DiagnosticOperations(() => `diagnostic-operation-${++serial}`);
  let pendingRepeat=null;
  const context=vm.createContext({
    ...model, diagnosticOps:{current:ops},diagnosticActorScope:actor,
    window:{location:{origin:'https://gateway.example.com'}},
    setRepeatDiagnosticCandidate:v=>{pendingRepeat=v;},
    fetchWithTimeout:async (url,init)=>{requests.push({url,key:init.headers['Idempotency-Key']});return send(url,init);},
    generateIdempotencyKey:()=>`diagnostic-operation-${++serial}`,
    setTestingPrinterId:v=>busy.push(v),setMessage:v=>messages.push(v),
    setUpgradeLimit:()=>{}, upgradeLimitFromApiError:()=>null,
    refreshData:()=>{},t:(key)=>key, apiMessageKey:()=> 'errors.testPageFailed',
    DashboardApiError:class DashboardApiError extends Error { constructor(key,code,obj){super(key);this.key=key;this.code=code;this.obj=obj;} },
  });
  vm.runInContext(compile(`${sendSource}\n${dashHandler}\nglobalThis.runDiagnostic = handleGatewayTestPrint;`),context);
  return {
    run:(id='printer1')=>context.runDiagnostic(id,`Printer ${id}`),
    pendingRepeat:()=>pendingRepeat,
    confirmRepeat:async()=>{
      const candidate=pendingRepeat;pendingRepeat=null;
      if (!candidate) return;
      const scope=model.diagnosticScope('https://gateway.example.com',actor,candidate.printerId);
      if (ops.confirmRepeat(scope)) await context.runDiagnostic(candidate.printerId,candidate.printerName);
    },
    messages,requests,busy,ops,actor,
  };
}
function gatewayResponse(body, status=201) {
  return {ok:status>=200&&status<300,status,json:async()=>body};
}
const good = (status='queued', id='printer1', extras={})=>({ok:true,jobId:`job-${id}`,printerId:id,status,...extras});
function makeDesktop(send,{url='https://gateway.example.com'}={}) {
  let serial=0;
  const messages=[]; const requests=[];
  const ops=new model.DiagnosticOperations(()=>`desktop-operation-${++serial}`);
  let pendingRepeat=null;
  const ipcContext=vm.createContext({
    ...model, normalizeGatewayUrl:value=>value,
    gatewayConsoleRequest:async (_url,path,method,_headers,_body,key)=>{
      requests.push({url:_url,path,key});
      return send(path,{'Idempotency-Key':key});
    },
    gatewayHttpError:(status,body)=>Object.assign(new Error(`HTTP_${status}`),{status,body}),
  });
  vm.runInContext(compile(`${ipcSource.replace(/^export /m, "")}\nglobalThis.send = testGatewayPrinter;`), ipcContext);
  const context=vm.createContext({
    ...model, useCallback:fn=>fn, diagnosticOps:{current:ops},savedGatewayUrl:url,
    window:{},setRepeatDiagnosticPrinterId:v=>{pendingRepeat=v;},
    testGatewayPrinter:ipcContext.send,
    setBusyBoth:()=>{},setMsg:v=>messages.push(v),refreshJobs:()=>{},
    t:key=>key,friendlyPrinterError:v=>v,errMsg:e=>String(e),locale:'en',
  });
  vm.runInContext(compile(`${desktopHandler}\nglobalThis.runDiagnostic=handleTest;`),context);
  return {
    run:(id='printer1')=>context.runDiagnostic(id),
    pendingRepeat:()=>pendingRepeat,
    confirmRepeat:async()=>{
      const id=pendingRepeat;pendingRepeat=null;
      if (id && ops.confirmRepeat(model.diagnosticScope(url,'paired-agent',id))) await context.runDiagnostic(id);
    },
    messages,requests,ops,
  };
}

test('strict decoder rejects malformed2xx and wrong printer/status/optional fields',()=>{
  for(const value of [null,{},[],{ok:false}, {ok:true,printerId:'printer1',status:'queued'},
    good('bogus'),good('queued','elsewhere'),good('queued','printer1',{jobId:'   '}),
    good('queued','printer1',{virtualCapture:'yes'}),good('queued','printer1',{isReused:1}),
    good('failed','printer1',{physicalOutcome:'maybe'})]){
      assert.throws(()=>model.decodeDiagnosticResult(value,'printer1'),model.InvalidDiagnosticResponse);
    }
    assert.equal(model.decodeDiagnosticResult(good('queued','printer1',{isReused:true}),'printer1').isReused,true);
});

test('valid terminal outcomes must not be announced as newly queued or guaranteed paper',()=>{
  for(const [status,outcome,key] of [
    ['queued',undefined,'diagnostic.queued'],['claimed',undefined,'diagnostic.inProgress'],
    ['printing',undefined,'diagnostic.inProgress'],['success','unknown','diagnostic.delivered'],
    ['failed',undefined,'diagnostic.unverified'],['failed','not_printed','diagnostic.failed'],
    ['expired','not_printed','diagnostic.expired'],['expired','unknown','diagnostic.unverified'],
    ['success','printed','diagnostic.delivered'],
  ]){
    assert.equal(model.diagnosticMessageKey(model.decodeDiagnosticResult(good(status,'printer1',{physicalOutcome:outcome}),'printer1')),key);
  }
  assert.equal(model.diagnosticMessageKey(model.decodeDiagnosticResult(good('success','printer1',{virtualCapture:true}),'printer1')),'diagnostic.virtualCaptured');
  assert.equal(model.diagnosticIsInProgress(model.decodeDiagnosticResult(good('queued'),'printer1')),true);
  assert.equal(model.diagnosticIsInProgress(model.decodeDiagnosticResult(good('success'),'printer1')),false);
});

test('model owns one synchronous identity, retains ambiguous key and fences origins/actors',()=>{
  let seq=0;const ops=new model.DiagnosticOperations(()=>`operation-key-${++seq}`);
  const a=model.diagnosticScope('https://host/', 'tenant1:user1','p1');
  const b=model.diagnosticScope('https://host','tenant1:user1','p2');
  const c=model.diagnosticScope('https://host','tenant2:user2','p1');
  const d=model.diagnosticScope('https://other','tenant1:user1','p1');
  const first=ops.begin(a);
  assert.equal(ops.begin(a),null);
  ops.uncertain(a); assert.equal(ops.begin(a),first);
  assert.equal(ops.confirmRepeat(a),false);
  ops.accept(a,model.decodeDiagnosticResult(good(),'printer1')); // printer evidence bound to scope by caller
  assert.equal(ops.observed(a)?.jobId,'job-printer1');
  assert.equal(ops.confirmRepeat(a),true);
  assert.notEqual(ops.begin(a),first);
  ops.uncertain(a);
  for (const scope of [b,c,d]) { const key=ops.begin(scope); assert.notEqual(key,first); ops.uncertain(scope); }
});

test('dashboard lost response then retry uses ONE Gateway idempotency key',async()=>{
  let sent=0;const fixture=makeDashboard(async()=>{if(++sent===1)throw new Error('response lost after commit');return gatewayResponse(good());});
  await fixture.run(); await fixture.run();
  assert.equal(fixture.requests.length,2);
  assert.equal(new Set(fixture.requests.map(r=>r.key)).size,1);
  assert.equal(fixture.messages.filter(Boolean)[0].text,'diagnostic.admissionUnknown');
  assert.equal(fixture.messages.at(-1).text,'diagnostic.queued');
});

test('dashboard same-tick clicks cannot admit twice; independent printers have independent keys',async()=>{
  let proceed;const latch=new Promise(resolve=>proceed=resolve);
  const fixture=makeDashboard(async(url)=>{await latch; return gatewayResponse(good('queued',url.endsWith('/printer2/test-print')?'printer2':'printer1'));});
  const a=fixture.run();const b=fixture.run();const c=fixture.run('printer2');
  assert.equal(fixture.requests.length,2);
  proceed();await Promise.all([a,b,c]);
  assert.equal(new Set(fixture.requests.map(r=>r.key)).size,2);
});

test('dashboard malformed, false ok, mismatched and unknown terminal2xx retain identity, no queued success',async()=>{
  for(const response of [null,{}, {ok:false},good('failed','wrong-printer'),good('invalid')]){
    let value=response;
    const fixture=makeDashboard(async()=>gatewayResponse(value));
    await fixture.run();
    assert.equal(fixture.messages.at(-1).text,'diagnostic.admissionUnknown');
    value=good('failed','printer1',{isReused:true});
    await fixture.run();
    assert.equal(new Set(fixture.requests.map(r=>r.key)).size,1);
    assert.equal(fixture.messages.at(-1).text,'diagnostic.unverified');
  }
});

test('dashboard in-flight diagnostic polls under the SAME key and never prompts a repeat',async()=>{
  let response=good('queued');
  const fixture=makeDashboard(async()=>gatewayResponse(response));
  await fixture.run();
  response=good('printing');
  await fixture.run();
  assert.equal(fixture.requests.length,2);
  assert.equal(new Set(fixture.requests.map(r=>r.key)).size,1);
  assert.equal(fixture.pendingRepeat(),null);
  assert.equal(fixture.messages.at(-1).text,'diagnostic.inProgress');
});

test('dashboard terminal outcome opens app confirmation before NEW intent',async()=>{
  let response=good('success');
  const fixture=makeDashboard(async()=>gatewayResponse(response));
  await fixture.run();
  await fixture.run();
  assert.equal(fixture.requests.length,1);
  assert.equal(fixture.pendingRepeat()?.printerId,'printer1');
  response=good('failed','printer1',{physicalOutcome:'not_printed'});
  await fixture.confirmRepeat();
  assert.equal(fixture.requests.length,2);
  assert.notEqual(fixture.requests[0].key,fixture.requests[1].key);
  assert.equal(fixture.messages.at(-1).text,'diagnostic.failed');
});

test('desktop live IPC strict2xx decoder and renderer use stable id on malformed and lost response',async()=>{
  let count=0;
  const fixture=makeDesktop(async()=>{
    count++;if(count===1)return {status:200,body:'{}'};
    if(count===2)throw new Error('lost response');
    return {status:200,body:JSON.stringify(good('failed','printer1',{isReused:true,physicalOutcome:'unknown'}))};
  });
  await fixture.run();await fixture.run();await fixture.run();
  assert.equal(new Set(fixture.requests.map(r=>r.key)).size,1);
  assert.equal(fixture.messages.filter(Boolean)[0].text,'diagnostic.admissionUnknown');
  assert.equal(fixture.messages.at(-1).text,'diagnostic.unverified');
});

test('desktop same tick guard and 401/403/503 retain identity; in-flight refresh keeps the key',async()=>{
  let status=401;let proceed;const latch=new Promise(resolve=>proceed=resolve);
  const fixture=makeDesktop(async()=>{
    await latch;
    return status===200 ? {status,body:JSON.stringify(good())}:{status,body:'{}'};
  });
  const a=fixture.run(); const b=fixture.run();
  assert.equal(fixture.requests.length,1);
  proceed();await Promise.all([a,b]);
  assert.equal(fixture.messages.at(-1).text,'diagnostic.authRequired');
  for(const s of [403,503,200]) {status=s;await fixture.run();}
  assert.equal(new Set(fixture.requests.map(r=>r.key)).size,1);
  assert.equal(fixture.messages.at(-1).text,'diagnostic.queued');
  await fixture.run();assert.equal(fixture.requests.length,5);
  assert.equal(fixture.pendingRepeat(),null);
  assert.equal(new Set(fixture.requests.map(r=>r.key)).size,1);
});

test('desktop terminal outcome requires an in-app confirmation before another print',async()=>{
  let status='success';
  const fixture=makeDesktop(async()=>({status:200,body:JSON.stringify(good(status))}));
  await fixture.run();
  await fixture.run();
  assert.equal(fixture.requests.length,1);
  assert.equal(fixture.pendingRepeat(),'printer1');
  status='failed';
  await fixture.confirmRepeat();
  assert.equal(fixture.requests.length,2);
  assert.notEqual(fixture.requests[0].key,fixture.requests[1].key);
});

test('unpaired Agent is denied by Gateway while preserving the same diagnostic retry key', async () => {
  const denied=makeDesktop(async()=>({status:401,body:'{"error":"Unauthorized"}'}));
  await denied.run('printer1');
  assert.equal(denied.requests.length,1);
  assert.equal(denied.messages.at(-1).text,'diagnostic.authRequired');
  await denied.run('printer1');
  assert.equal(new Set(denied.requests.map(x=>x.key)).size,1);
});
