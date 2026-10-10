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
  // Show only executable physical/approved virtual queues, pending software
  // state, and explicitly configured test-only file capture. Unrelated
  // discovery-only virtual/redirected queues must not enter the job list.
  assert.match(codeFile('src/desktop/main.tsx'),/setPrinters\\(list\\.filter\\(\\(printer\\) => isProductionPrinter\\(printer\\) \\|\\| isPendingVirtualSpoolerTestPrinter\\(printer\\) \\|\\| isVirtualCaptureTestRecord\\(printer\\)\\)\\)/);
});

test('real Desktop registers explicitly selected virtual and physical queues only via its paired Agent',async()=>{
  const called=[];
  const ipc=actualModule('src/desktop/lib/ipc.ts',{
    '@tauri-apps/api/core':{invoke:async(cmd,{args})=>{
      called.push({cmd,args});
      return JSON.stringify({status:201,body:JSON.stringify({id:'physical-1'})});
    }},
    '@tauri-apps/api/event':{listen:async()=>()=>{}},
    '../../shared/diagnostic-test':{decodeDiagnosticResult:()=>({})},
  },{window:{__TAURI_INTERNALS__:{}}});
  await ipc.registerGatewayPrinter('https://gateway.example.test',{
    name:'Microsoft Print to PDF',agentId:'agent-id',connectionType:'spooler',protocol:'spooler',spoolerName:'Microsoft Print to PDF',virtualSpoolerTest:true,
  });
  assert.equal(called[0].cmd,'gateway_agent_request');
  assert.equal(JSON.parse(called[0].args.body).config.virtual_spooler_test,true);
  assert.equal(JSON.parse(called[0].args.body).printerType,'virtual');
  await assert.rejects(()=>ipc.registerGatewayPrinter('https://gateway.example.test',{
    name:'Bad PDF',agentId:'agent-id',connectionType:'spooler',protocol:'spooler',spoolerName:'PDF',virtualSpoolerTest:true,spoolerPassthroughProtocols:['raw'],
  }),/does not accept RAW passthrough/);
  assert.equal(called.length,1,'rejected RAW software queue must not reach Gateway');
  await ipc.registerGatewayPrinter('https://gateway.example.test',{
    name:'Office Laser',agentId:'agent-id',connectionType:'spooler',spoolerName:'Office Laser',printerType:'physical',
  });
  assert.equal(called[1].cmd,'gateway_agent_request');
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
test('real PrintersPage enables discovered virtual queues and tests only verified ones',()=>{
  const page=actualModule('src/desktop/pages/Printers.tsx',uiImports);
  const queue={id:'local-win-pdf',name:'Microsoft Print to PDF',spoolerName:'Microsoft Print to PDF',agentId:'agent-1',printerType:'virtual'};
  let tested=null, enabled=null;
  const base={printers:[],pendingVirtualGatewayPrinters:[],filteredPrinters:[],discoveredPrinters:[],discoveredVirtualPrinters:[queue],printersFilter:'',statusFilter:'all',nowMs:0,printersLoading:false,busy:false,
    enableVirtualPrinterTest:p=>{enabled=p;},handleTest:id=>{tested=id;},setPrintersFilter:()=>{},setStatusFilter:()=>{},setShowAdd:()=>{},handleDiscover:()=>{},refreshPrinters:()=>{}};
  const first=page.PrintersPage({s:base});
  const enable=flat(first,x=>x.type==='Button'&&x.props.children==='desktop.printers.virtualEnable')[0];
  assert.ok(enable,'opt-in button must be present without Manager sign-in');
  enable.props.onClick();
  assert.equal(enabled,queue);
  const linked={...software,id:'gateway-pdf',agentId:'agent-1',spoolerName:'Microsoft Print to PDF'};
  const second=page.PrintersPage({s:{...base,printers:[linked],filteredPrinters:[linked]}});
  const testButton=flat(second,x=>x.type==='Button'&&x.props.children==='desktop.printers.test')[0];
  assert.ok(testButton,'Gateway-approved software queue has a real test action');
  testButton.props.onClick();
  assert.equal(tested,'gateway-pdf');
  const pending={...linked,capabilities:null};
  const pendingTree=page.PrintersPage({s:{...base,pendingVirtualGatewayPrinters:[pending]}});
  assert.equal(flat(pendingTree,x=>x.type==='Button'&&x.props.children==='desktop.printers.virtualEnable').length,0,'pending intent must not be resubmitted');
  assert.equal(flat(pendingTree,x=>x.type==='Button'&&x.props.children==='desktop.printers.test').length,0,'unverified queue is not printable');
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
    execute:async query=>({
      rows:query.segments?.join('')?.includes('SELECT lifecycle FROM agents')
        && query.values?.[0]==='agent-one' && query.values?.[1]==='tenant-one'
        ?[{lifecycle:'active'}]:[],
    }),
    insert:()=>({values:(data)=>({returning:async()=>{saved.push(data);return [{...data}];}})}),
  };
  const api=actualModule('src/app/api/printers/route.ts',{
    'next/server':{NextResponse:reply},'node:crypto':nodeRequire('node:crypto'),
    '../../../db':{db:{transaction:callback=>callback(tx)}},
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
  assert.equal(agentAttempt.status,201,'paired Agent may explicitly opt into its OWN verified software writer');
  assert.equal(saved.length,2);
  assert.equal(saved[1].managementSource,'manager','Gateway desired state must be synced to Windows Agent for OS validation');
  assert.equal(saved[1].desiredRevision,1);
  assert.equal(saved[1].capabilities,null,'Agent request cannot fake OS verification');
  assert.match(saved[1].id,/^printer_vt_[a-f0-9]{24}$/);
  const second=await api.POST(req(data));
  assert.equal(second.status,201);
  assert.equal(saved[2].id,saved[1].id,'ambiguous retry must target the same derived printer identity');
  identity={kind:'agent',agent:{id:'other-agent',tenantId:'tenant-one'}};
  assert.equal((await api.POST(req(data))).status,403,'Agent cannot authorize a printer owned by another Agent');
  identity={kind:'agent',agent:{id:'agent-one',tenantId:'other-tenant'}};
  assert.equal((await api.POST(req(data))).status,404,'a foreign-tenant Agent must not find this printer owner');
  identity={kind:'agent',agent:{id:'agent-one',tenantId:'tenant-one'}};
  assert.equal((await api.POST(req({...data,config:{...data.config,spooler_name:'Fax'}}))).status,400);
  assert.equal((await api.POST(req({...data,config:{...data.config,spooler_name:'HP (redirected 3)'}}))).status,400);
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
