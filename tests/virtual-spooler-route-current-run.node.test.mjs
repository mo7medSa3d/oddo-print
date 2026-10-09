/** Behavioral tests of actual Yaseir contracts with only OS/DB/IPC boundaries substituted.
 * Native Windows service, real Gateway/Postgres, Odoo and paper remain separate acceptance gates.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const nodeRequire=createRequire(import.meta.url);
const ts=nodeRequire('typescript');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const codeFile=p=>readFileSync(path.join(root,p),'utf8');
function actualModule(p,imports={},env={}) {
  const source=codeFile(p);
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true,resolveJsonModule:true}}).outputText;
  const cjsModule={exports:{}};
  const importer=name=>{
    if(!(name in imports))throw Error(`${p} unexpected import: ${name}`);
    return imports[name];
  };
  new Function('require','module','exports','window','fetch','URL','AbortController','setTimeout','clearTimeout',js)(
    importer,cjsModule,cjsModule.exports,env.window,env.fetch,URL,AbortController,setTimeout,clearTimeout);
  return cjsModule.exports;
}
const virtual=actualModule('src/lib/printer-virtual.ts');
const routing=actualModule('src/lib/routing.ts',{
  '../../contracts/print-payload-contract.json':{rawProtocols:['raw','escpos','zpl','tspl']},
  './database-clock':{gatewayNow:()=>new Date('2026-10-09T10:00:00Z')},
  './printer-virtual':virtual,
  './agent-availability':{getAgentAvailability:()=>({available:true})},
  './printer-capability':{validatePayloadForPrinter:()=>({ok:true})},
});
const software={
  name:'Microsoft Print to PDF',printerType:'virtual',managementSource:'manager',connectionType:'spooler',protocol:'spooler',
  status:'online',lifecycle:'active',inventoryPresent:true,
  config:{spooler_name:'Microsoft Print to PDF',virtual_spooler_test:true},
  capabilities:{virtual_spooler_test:true,port_name:'PORTPROMPT:',supported_protocols:['pdf','image']},
};

test('real Gateway availability admits only manager-authorized, Agent-observed software spooler queues',()=>{
  assert.equal(virtual.isVirtualPrinterRecord(software),true);
  assert.equal(virtual.isApprovedVirtualSpoolerTestRecord(software),true);
  assert.equal(routing.isPrinterAvailableForJob(software),true);
  for(const altered of [
    {...software,managementSource:'agent'},
    {...software,config:{spooler_name:'Microsoft Print to PDF'}},
    {...software,capabilities:{supported_protocols:['pdf']}},
    {...software,printerType:'redirected'},
    {...software,connectionType:'network'},
    {...software,protocol:'raw'},
    {...software,inventoryPresent:false},
    {...software,lifecycle:'disabled'},
    {...software,status:'offline'},
    {...software,name:'HP Laser (redirected 3)'},
    {...software,config:{spooler_name:'Fax',virtual_spooler_test:true}},
    {...software,capabilities:{virtual_spooler_test:true,virtual_test_sink:true}},
  ]){
    assert.equal(routing.isPrinterAvailableForJob(altered),false,`must reject ${JSON.stringify(altered)}`);
  }
  assert.equal(routing.isPrinterAvailableForJob({name:'Office Laser',printerType:'physical',connectionType:'spooler',protocol:'spooler',status:'online',lifecycle:'active'}),true,'normal printer unchanged');
});

test('real Manager login preserves upstream 401/502 status when a proxy returns non-JSON',async()=>{
  let status=502;
  const ipc=actualModule('src/desktop/lib/ipc.ts',{
    '@tauri-apps/api/core':{invoke:async()=>({status,body:'<html>upstream unavailable</html>'})},
    '@tauri-apps/api/event':{listen:async()=>()=>{}},
    '../../shared/diagnostic-test':{decodeDiagnosticResult:()=>({})},
  },{window:{__TAURI_INTERNALS__:{}}});
  for(const expected of [502,401]){
    status=expected;
    await assert.rejects(()=>ipc.loginManager('https://gateway.example.test','manager@example.test','password'),err=>{
      assert.equal(err.status,expected);
      assert.equal(String(err.message).includes('upstream unavailable'),false);
      return true;
    });
  }
});

test('real Desktop presenter retains pending software queue without making it printable',()=>{
  const presenter=actualModule('src/desktop/lib/printers.ts',{
    '../../lib/printer-virtual':virtual,
    '../../shared/job-vocabulary':{},
    '../../i18n/config':{DEFAULT_LOCALE:'en'},
    '../../i18n/translate':{translate:()=>''},
  });
  const pending={...software,capabilities:null,id:'virtual-pending'};
  assert.equal(presenter.isPendingVirtualSpoolerTestPrinter(pending),true);
  assert.equal(presenter.isProductionPrinter(pending),false);
  assert.equal(presenter.isPendingVirtualSpoolerTestPrinter(software),false);
  assert.equal(presenter.isProductionPrinter(software),true);
  assert.equal(presenter.isPendingVirtualSpoolerTestPrinter({...pending,managementSource:'agent'}),false);
  assert.match(codeFile('src/desktop/main.tsx'),/setPrinters\(list\.filter\(\(printer\) => isProductionPrinter\(printer\) \|\| isPendingVirtualSpoolerTestPrinter\(printer\)\)\)/);
});

test('real Desktop registration uses Manager bearer gateway_request for opt-in virtual, Agent transport for physical',async()=>{
  const called=[];
  const ipc=actualModule('src/desktop/lib/ipc.ts',{
    '@tauri-apps/api/core':{invoke:async(cmd,{args})=>{
      called.push({cmd,args});
      return cmd==='gateway_request' ? {status:201,body:JSON.stringify({id:'virtual-1'})} : JSON.stringify({status:201,body:JSON.stringify({id:'physical-1'})});
    }},
    '@tauri-apps/api/event':{listen:async()=>()=>{}},
    '../../shared/diagnostic-test':{decodeDiagnosticResult:()=>({})},
  },{window:{__TAURI_INTERNALS__:{}}});
  const response=await ipc.registerGatewayPrinter('https://gateway.example.test',{
    name:'Microsoft Print to PDF',agentId:'agent-id',connectionType:'spooler',protocol:'spooler',spoolerName:'Microsoft Print to PDF',virtualSpoolerTest:true,
  });
  assert.equal(response.id,'virtual-1');
  assert.equal(called[0].cmd,'gateway_request');
  assert.equal(called[0].args.path,'/api/printers');
  const payload=JSON.parse(called[0].args.body);
  assert.equal(payload.agentId,'agent-id');
  assert.deepEqual(payload.config,{spooler_name:'Microsoft Print to PDF',address:'Microsoft Print to PDF',passthrough_protocols:[],virtual_spooler_test:true});
  assert.equal(payload.printerType,'virtual');
  assert.equal(payload.protocol,'spooler');
  await assert.rejects(()=>ipc.registerGatewayPrinter('https://gateway.example.test',{
    name:'PDF',agentId:'agent-id',connectionType:'spooler',spoolerName:'PDF',virtualSpoolerTest:true,spoolerPassthroughProtocols:['raw'],
  }),/does not accept RAW passthrough/);
  assert.equal(called.length,1,'invalid passthrough must not reach Gateway');
  await ipc.registerGatewayPrinter('https://gateway.example.test',{
    name:'Office Laser',agentId:'agent-id',connectionType:'spooler',spoolerName:'Office Laser',printerType:'physical',
  });
  assert.equal(called[1].cmd,'gateway_agent_request','physical registrations keep legacy owner transport');
  assert.equal(JSON.parse(called[1].args.body).printerType,'physical');
});

function flat(node,match){
  if(!node||typeof node!=='object')return [];
  return [...(match(node)?[node]:[]),...[node.props?.children].flat(Infinity).flatMap(child=>flat(child,match))];
}
const element=(type,props)=>({type:typeof type==='string'?type:(type?.displayName??type?.name??String(type)),props:props??{}});
const icon=()=>null;
const uiImports={
  react:{default:{}},'react/jsx-runtime':{jsx:element,jsxs:element},
  'lucide-react':new Proxy({},{get:()=>icon}),
  '../../components/ui':Object.fromEntries(['Button','Card','CardHeader','EmptyState','ErrorState','Input','LoadingState','Mono','Select','StatusBadge','StatusDot'].map(x=>[x,x])),
  '../ui':Object.fromEntries(['Toolbar','PrinterAvatar','DetailList','StatItem','StatStrip','StatusNotice','ViewAllButton'].map(x=>[x,x])),
  '../../i18n/react':{useI18n:()=>({t:(key)=>key,tc:key=>key,locale:'en',formatTime:x=>x,formatDateTime:x=>x})},
  '../../lib/lifecycle-labels':{lifecycleLabel:()=> 'active'},
  '../lib/printers':{
    humanConnection:()=> 'spooler',humanType:()=> 'virtual',isProductionPrinter:p=>p.managementSource==='manager'&&!!p.config?.virtual_spooler_test&&!!p.capabilities?.virtual_spooler_test,
    labelPrinter:()=> 'online',printerAgentView:()=>({label:'Agent'}),printerDisplayStatus:()=> 'online',printerHealthCounts:()=>({offline:0,unknown:0,online:0}),printerEndpoint:p=>p.spoolerName??'',printerIsStale:()=>false,printerTone:()=> 'ok',
  },
};
test('real PrintersPage offers opt-in button for installed software queue and test button after verified registration',()=>{
  const page=actualModule('src/desktop/pages/Printers.tsx',uiImports);
  const queue={id:'local-win-pdf',name:'Microsoft Print to PDF',spoolerName:'Microsoft Print to PDF',agentId:'agent-1',printerType:'virtual'};
  let enabled=null, tested=null;
  const base={printers:[],filteredPrinters:[],discoveredPrinters:[],discoveredVirtualPrinters:[queue],printersFilter:'',statusFilter:'all',nowMs:0,printersLoading:false,busy:false,
    enableVirtualPrinterTest:p=>{enabled=p;},handleTest:id=>{tested=id;},setPrintersFilter:()=>{},setStatusFilter:()=>{},setShowAdd:()=>{},handleDiscover:()=>{},refreshPrinters:()=>{},};
  const first=page.PrintersPage({s:base});
  const buttons=flat(first,x=>x.type==='Button');
  const enable=buttons.find(x=>x.props.children==='desktop.printers.virtualEnable');
  assert.ok(enable,'virtual software destination must have an interactive registration action');
  enable.props.onClick();
  assert.equal(enabled,queue);
  const linked={...software,id:'gateway-pdf',agentId:'agent-1',spoolerName:'Microsoft Print to PDF'};
  const second=page.PrintersPage({s:{...base,printers:[linked],filteredPrinters:[linked]}});
  const linkedButtons=flat(second,x=>x.type==='Button');
  assert.equal(linkedButtons.some(x=>x.props.children==='desktop.printers.virtualEnable'),false,'no double-register');
  const testButton=linkedButtons.find(x=>x.props.children==='desktop.printers.test');
  assert.ok(testButton,'approved Windows software queue has a real test action');
  testButton.props.onClick();
  assert.equal(tested,'gateway-pdf');
  const pending={...linked,capabilities:null};
  const pendingTree=page.PrintersPage({s:{...base,printers:[pending],filteredPrinters:[pending]}});
  assert.equal(flat(pendingTree,x=>x.type==='Button'&&x.props.children==='desktop.printers.virtualEnable').length,0,'pending Manager row must not offer duplicate registration');
  assert.equal(flat(pendingTree,x=>x.type==='Button'&&x.props.children==='desktop.printers.test').length,0,'pending rows cannot be tested before Agent confirms the queue');
  assert.equal(flat(pendingTree,x=>x.type==='StatusBadge'&&x.props.label==='desktop.printers.waitingForSync').length,1);
});

test('real ManagerAccountPanel distinguishes 401, 429, 503 and transport errors, without leaking upstream body',async()=>{
  const panel=actualModule('src/desktop/components/ManagerAccountPanel.tsx',{
    react:{useRef:()=>({current:false}),useState:(value)=>[value,()=>{}]},
    'react/jsx-runtime':{jsx:element,jsxs:element},
    '../../components/ui':Object.fromEntries(['Button','Field','Input','StatusBadge'].map(k=>[k,k])),
    '../../i18n/react':{useI18n:()=>({t:k=>k})},
  });
  // State re-render harness used by real component (not a mocked submit handler).
  function make(status){let slots=[],refs=[],at=0,ri=0;const useState=initial=>{const index=at++;if(!(index in slots))slots[index]=initial;return [slots[index],v=>{slots[index]=v;}];};
    const useRef=initial=>{const index=ri++;if(!(index in refs))refs[index]={current:initial};return refs[index];};
    const scoped=actualModule('src/desktop/components/ManagerAccountPanel.tsx',{
      react:{useRef,useState},'react/jsx-runtime':{jsx:element,jsxs:element},
      '../../components/ui':Object.fromEntries(['Button','Field','Input','StatusBadge'].map(k=>[k,k])),
      '../../i18n/react':{useI18n:()=>({t:k=>k})},
    });
    const login=async()=>{const err=new Error('DO NOT LEAK SECRET');if(status!=null)err.status=status;throw err;};
    const props={gatewayUrl:'https://example.test',account:{origin:'https://example.test',status:'signed-out',session:null},login,logout:async()=>{},refresh:()=>{}};
    const render=()=>{at=0;ri=0;return scoped.ManagerAccountPanel(props);};
    return {render};
  }
  assert.equal(typeof panel.ManagerAccountPanel,'function');
  for(const [status,key] of [[401,'desktop.manager.invalidCredentials'],[429,'desktop.manager.rateLimited'],[503,'desktop.manager.serviceUnavailable'],[null,'desktop.manager.connectionFailed']]){
    const ui=make(status),first=ui.render();const inputs=flat(first,x=>x.type==='Input');
    inputs[0].props.onChange({target:{value:'manager@company.test'}});
    inputs[1].props.onChange({target:{value:'secret'}});
    const form=flat(ui.render(),x=>x.type==='form')[0];
    await form.props.onSubmit({preventDefault:()=>{}});
    const error=flat(ui.render(),x=>x.type==='p'&&x.props.role==='alert')[0];
    assert.equal(error.props.children,key);
    assert.equal(String(error.props.children).includes('DO NOT LEAK SECRET'),false);
  }
});

test('Gateway lifecycle printer status labels are translated rather than repeated unknowns',()=>{
  const labels=actualModule('src/lib/lifecycle-labels.ts');
  const t=x=>({'lifecycle.disabled':'معطّل','lifecycle.retired':'متقاعد','lifecycle.active':'نشط'})[x]??x;
  assert.equal(labels.lifecycleLabel(t,'disabled'),'معطّل');
  assert.equal(labels.lifecycleLabel(t,'retired'),'متقاعد');
  assert.notEqual(labels.lifecycleLabel(t,'disabled'),labels.lifecycleLabel(t,'retired'));
  assert.match(codeFile('src/app/dashboard/dashboard-client.tsx'),/status === "disabled" \|\| status === "retired" \? lifecycleLabel\(t, status\)/);
});

const reply={json:(payload,options={})=>new Response(JSON.stringify(payload),{status:options.status??200,headers:options.headers})};
const sql=(segments,...values)=>({segments,values});
const schemaFields=new Proxy({},{get:(_obj,name)=>name});
const drizzle={and:()=>({}),eq:()=>({}),desc:()=>({}),lt:()=>({}),or:()=>({}),sql};

test('actual Manager POST printer handler stores opt-in as desired state but does not pretend Agent observed it',async()=>{
  const saved=[];
  let identity={kind:'manager',claims:{tenantId:'tenant-one',userId:'user-one'}};
  const tx={
    execute:async query=>({rows:query.segments?.join('')?.includes('SELECT lifecycle FROM agents')?[{lifecycle:'active'}]:[]}),
    insert:()=>({values:(data)=>({returning:async()=>{saved.push(data);return [{...data}];}})}),
  };
  const api=actualModule('src/app/api/printers/route.ts',{
    'next/server':{NextResponse:reply},'../../../db':{db:{transaction:callback=>callback(tx)}},
    '../../../db/schema':{printers:schemaFields,agents:schemaFields},
    '../../../lib/console-auth':{validateConsoleAuth:async()=>identity},
    '../../../lib/authorization':{requireManagerPermission:()=>{}},
    '../../../lib/manager-mutation-authorization':{requireManagerActorInTransaction:async()=>{},ManagerMutationAuthorityChangedError:class extends Error{}},
    '../../../lib/tenant-guard':{requireActiveTenantInTransaction:async()=>{}},
    'drizzle-orm':drizzle,
    '../../../lib/request-limits':{clampListLimit:()=>1000},
    '../../../lib/fleet-cursor':{fleetCursorIdHeaders:()=>({}),readFleetCursorId:()=>null},
    '../../../lib/nanoid':{nanoid:()=> '12345678'},
    '../../../lib/printer-model':{parsePrinterInput:x=>x,validateConnectionConfig:()=>null,validatePrinterTransportProtocol:()=>null},
    '../../../lib/audit':{writeAuditEvent:async()=>{}},
    '../../../lib/entitlements':{enforceTenantResourceEntitlement:async()=>{},TenantEntitlementError:class extends Error{},isTenantBillingError:()=>false},
    '../../../lib/agent-availability':{agentStaleThresholdSeconds:()=>60,getAgentHeartbeatFreshness:()=> 'fresh',getEffectiveAgentStatus:()=> 'online',getEffectivePrinterStatus:()=> 'online',getPrinterObservationFreshness:()=> 'fresh'},
    '../../../lib/database-clock':{gatewayNow:()=>new Date(),refreshClockSkew:async()=>{}},
    '../../../lib/log':{logError:()=>{}},
  });
  const data={agentId:'agent-one',name:'Microsoft Print to PDF',printerType:'virtual',deviceClass:'unknown',connectionType:'spooler',protocol:'spooler',config:{spooler_name:'Microsoft Print to PDF',virtual_spooler_test:true}};
  const req=payload=>new Request('https://gateway.example.test/api/printers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
  const ok=await api.POST(req(data));
  assert.equal(ok.status,201);
  assert.equal(saved.length,1);
  assert.equal(saved[0].managementSource,'manager');
  assert.equal(saved[0].desiredRevision,1);
  assert.equal(saved[0].appliedDesiredRevision,0);
  assert.equal(saved[0].capabilities,null,'manager intent alone is not Agent printer evidence');
  assert.equal(saved[0].config.virtual_spooler_test,true);
  const missingConsent=await api.POST(req({...data,config:{spooler_name:'Microsoft Print to PDF'}}));
  assert.equal(missingConsent.status,400);
  assert.equal(saved.length,1);
  const rawAttempt=await api.POST(req({...data,config:{...data.config,passthrough_protocols:['raw']}}));
  assert.equal(rawAttempt.status,400);
  identity={kind:'agent',agent:{id:'agent-one',tenantId:'tenant-one'}};
  const agentAttempt=await api.POST(req(data));
  assert.equal(agentAttempt.status,400,'Agent execution credential cannot opt a local writer into business jobs');
  assert.equal(saved.length,1);
});

test('actual Odoo printer inventory only publishes Manager+Agent confirmed virtual queues',async()=>{
  let authenticated=true;
  const rows=[
    {...software,id:'pdf-approved',agentId:'agent-one',agentName:'Agent A',agentStatus:'online',agentLifecycle:'active',status:'online',lastSeenAt:new Date()},
    {...software,id:'pdf-pending',agentId:'agent-one',agentName:'Agent A',agentStatus:'online',agentLifecycle:'active',capabilities:null,lastSeenAt:new Date()},
    {...software,id:'pdf-agent-only',agentId:'agent-one',agentName:'Agent A',agentStatus:'online',agentLifecycle:'active',managementSource:'agent',lastSeenAt:new Date()},
    {...software,id:'fax-unapproved',agentId:'agent-one',agentName:'Agent A',agentStatus:'online',agentLifecycle:'active',name:'Fax',lastSeenAt:new Date()},
    {id:'physical',name:'Office Laser',printerType:'physical',connectionType:'spooler',protocol:'spooler',status:'online',lifecycle:'active',agentId:'agent-one',agentName:'Agent A',agentStatus:'online',agentLifecycle:'active',lastSeenAt:new Date(),capabilities:null},
  ];
  const query={innerJoin(){return this;},orderBy(){return Promise.resolve(rows);},where(){return this;},from(){return this;}};
  const api=actualModule('src/app/api/odoo/printers/route.ts',{
    'next/server':{NextResponse:reply},'drizzle-orm':drizzle,
    '../../../../db':{db:{select:()=>query}},'../../../../db/schema':{printers:schemaFields,agents:schemaFields},
    '../../../../lib/odoo-auth':{validateOdooKey:async()=>authenticated?{tenantId:'tenant-one'}:null},
    '../../../../lib/agent-availability':{getAgentHeartbeatFreshness:()=> 'fresh',getEffectivePrinterStatus:()=> 'online',getPrinterObservationFreshness:()=> 'fresh'},
    '../../../../lib/database-clock':{gatewayNow:()=>new Date(),refreshClockSkew:async()=>{}},
    '../../../../lib/receipt-width':{receiptRasterWidthDots:()=>null},
    '../../../../lib/entitlements':{TenantSubscriptionRequiredError:class extends Error{},requireTenantBillingAccess:async()=>{}},
    '../../../../lib/printer-virtual':virtual,
  });
  const request=new Request('https://gateway.example.test/api/odoo/printers?agent_id=agent-one');
  const result=await api.GET(request);
  assert.equal(result.status,200);
  const body=await result.json();
  assert.deepEqual(body.printers.map(p=>p.id),['pdf-approved','physical']);
  assert.deepEqual(body.printers[0].capabilities.supported_protocols.sort(),['image','pdf']);
  authenticated=false;
  const denied=await api.GET(request);
  assert.equal(denied.status,401);
});

test('real OverviewPage quick Check Connection action remains clickable with wrapping label in a narrow card',()=>{
  const page=actualModule('src/desktop/pages/Overview.tsx',{
    ...uiImports,
    '../../lib/printer-capability':{getPrinterLanguageBadges:()=>[]},
    '../lib/printers':{...uiImports['../lib/printers'],deriveOutcome:()=> 'unknown',agentStatusNoteKey:()=> 'status.unknown',
      jobDocType:()=>'',jobId:()=>'',jobPrinterId:()=>'',jobStatus:()=>'',jobTimestamp:()=>'',labelJob:()=>'',toneJob:()=>'',},
    '../ui':{...uiImports['../ui'],PrinterAvatar:'PrinterAvatar'},
  });
  let checks=0,refreshes=0;
  const s=new Proxy({
    jobs:[],printers:[],discoveredPrinters:[],pendingJobs:0,failedJobs:0,nowMs:0,
    gatewayUrl:'https://gateway.example.test',gatewayConnected:true,isOnline:true,
    jobsError:null,printersError:null,printersLoading:false,jobsLoading:false,
    checkHealth:()=>{checks++;},refreshStatus:()=>{refreshes++;},navigate:()=>{},
    setShowAdd:()=>{},handleDiscover:()=>{},refreshPrinters:()=>{},refreshJobs:()=>{},
  },{get:(target,k)=>k in target?target[k]:null});
  const tree=page.OverviewPage({s});
  const health=flat(tree,x=>x.type==='Button'&&x.props.children?.props?.children==='desktop.overview.checkGateway')[0];
  const refresh=flat(tree,x=>x.type==='Button'&&x.props.children?.props?.children==='desktop.overview.refresh')[0];
  assert.ok(health,'quick actions must expose a live Check Connection button');
  assert.ok(refresh);
  assert.match(health.props.className,/min-w-0 w-full/);
  assert.match(health.props.children.props.className,/whitespace-normal/);
  const actionGroup=flat(tree,x=>x.type==='div'&&typeof x.props.className==='string'&&x.props.className.includes('grid min-w-0 grid-cols-1 gap-2'));
  assert.equal(actionGroup.length,1,'layout uses card width, not viewport breakpoint, for overflow-safe one-column actions');
  health.props.onClick();refresh.props.onClick();
  assert.equal(checks,1);assert.equal(refreshes,1);
});
