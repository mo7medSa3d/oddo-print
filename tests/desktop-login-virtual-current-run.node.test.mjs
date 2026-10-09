// Exercises the real ManagerAccountPanel function after TypeScript JSX transpilation.
// React scheduler, visuals and HTTP/native IPC are external seams, not emulated as acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source=readFileSync(path.join(root,'src/desktop/components/ManagerAccountPanel.tsx'),'utf8');

function setup({ gatewayUrl='https://gateway.example.com', login=async()=>{} }={}) {
  const state=[]; const refs=[]; let current=0; let currentRef=0; const t=x=>x;
  const useState=initial=>{ const i=current++; if (!(i in state)) state[i]=initial; return [state[i],v=>{state[i]=v;}]; };
  const useRef=initial=>{ const i=currentRef++; if (!(i in refs)) refs[i]={current:initial}; return refs[i]; };
  const jsx=(type,props)=>({ type:typeof type==='function'?(type.displayName||type.name):type,props:props??{} });
  const treeWalk=(node, fn)=>{
    if (!node || typeof node !== 'object') return [];
    const result=fn(node)?[node]:[];
    for(const child of [node.props?.children].flat(Infinity)) result.push(...treeWalk(child, fn));
    return result;
  };
  const code=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const cjsModule={exports:{}};
  const imported=(name)=>{
    if(name==='react')return {useState,useRef};
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
    if(name==='../../components/ui')return Object.fromEntries(['Button','Field','Input','StatusBadge'].map(x=>[x,{[x]:function(){}}[x]]));
    if(name==='../../i18n/react')return {useI18n:()=>({t})};
    throw Error('unexpected import '+name);
  };
  new Function('require','module','exports',code)(imported,cjsModule,cjsModule.exports);
  let account={origin:gatewayUrl,status:'signed-out',session:null};
  const render=()=>{current=0;currentRef=0;return cjsModule.exports.ManagerAccountPanel({gatewayUrl,account,login,logout:async()=>{},refresh:()=>{}});};
  const find=(tree,type)=>treeWalk(tree,x=>x.type===type);
  return { render,find,state };
}

test('real ManagerAccountPanel accepts valid plain username; submits once with password and releases busy guard',async()=>{
  const calls=[];
  const app=setup({login:async (...args)=>{calls.push(args);}});
  let tree=app.render();
  const inputs=app.find(tree,'Input');
  assert.equal(inputs.length,2);
  assert.equal(inputs[0].props.type,'text','HTML email validation blocked plain Gateway username before React onSubmit');
  assert.equal(inputs[0].props.disabled,false);
  inputs[0].props.onChange({target:{value:'admin'}});
  inputs[1].props.onChange({target:{value:'example-secret'}});
  tree=app.render();
  const submit=app.find(tree,'Button').find(x=>x.props.type==='submit');
  assert.equal(submit.props.disabled,false,'button must not silently disable for valid credentials');
  let prevented=0;
  await app.find(tree,'form')[0].props.onSubmit({preventDefault:()=>prevented++});
  assert.deepEqual(calls,[['admin','example-secret']]);
  assert.equal(prevented,1);
});

test('real ManagerAccountPanel gives an actionable Gateway error rather than a dead login button',async()=>{
  const calls=[];
  const app=setup({gatewayUrl:'',login:async(...args)=>calls.push(args)});
  let tree=app.render();
  assert.equal(app.find(tree,'Button').find(x=>x.props.type==='submit').props.disabled,false);
  await app.find(tree,'form')[0].props.onSubmit({preventDefault:()=>{}});
  tree=app.render();
  assert.equal(app.find(tree,'p').some(x=>x.props.role==='alert' && x.props.children==='desktop.manager.setGatewayFirst'),true);
  assert.equal(calls.length,0);
});

test('virtual inspection is distinct from production routing, and Check Connection label wraps',()=>{
  const rust=readFileSync(path.join(root,'src-tauri/src/commands.rs'),'utf8');
  const cli=readFileSync(path.join(root,'agent/cmd/cli/main.go'),'utf8');
  const win=readFileSync(path.join(root,'agent/internal/printer/spooler_windows.go'),'utf8');
  const page=readFileSync(path.join(root,'src/desktop/pages/Printers.tsx'),'utf8');
  const settings=readFileSync(path.join(root,'src/desktop/pages/Settings.tsx'),'utf8');
  assert.match(cli,/if includeVirtual\s*\{[\s\S]*EnumSpoolerQueuesForDiagnostics/);
  assert.match(cli,/if !printer\.IsVirtualDevice\(di\)/);
  assert.match(win,/if !includeVirtual && isVirtualSpooler/);
  assert.match(rust,/let \(printers, virtual_printers\) = parse_discovery_stdout/);
  assert.match(page,/s\.discoveredVirtualPrinters\.map/);
  assert.doesNotMatch(page,/testGatewayPrinter\(.+virtual/i);
  assert.match(settings,/min-w-0 whitespace-normal break-words text-center leading-snug/);
});


test('same-tick double submit invokes login once, and a rejected request releases the guard', async()=>{
  let rejectFirst; const calls=[];
  const app=setup({login:(...args)=>{calls.push(args);return new Promise((_ok,reject)=>{rejectFirst=reject;});}});
  let tree=app.render();const fields=app.find(tree,'Input');
  fields[0].props.onChange({target:{value:'admin@example.test'}});
  fields[1].props.onChange({target:{value:'secret'}});
  tree=app.render(); const action=app.find(tree,'form')[0].props.onSubmit;
  const one=action({preventDefault:()=>{}}), two=action({preventDefault:()=>{}});
  assert.equal(calls.length,1,'duplicate submit cannot create two live tokens');
  rejectFirst(new Error('gateway refused'));await Promise.all([one,two]);
  tree=app.render();
  assert.equal(app.find(tree,'p').some(x=>x.props.role==='alert' && x.props.children==='desktop.manager.connectionFailed'),true);
  assert.equal(app.find(tree,'Button').find(x=>x.props.type==='submit').props.disabled,false);
  app.find(tree,'Input')[1].props.onChange({target:{value:'secret-again'}});
  tree=app.render();
  const next=app.find(tree,'form')[0].props.onSubmit({preventDefault:()=>{}});
  assert.equal(calls.length,2,'after error the guard must release for a deliberate retry');
  rejectFirst(new Error('still offline'));await next;
});

test('real SettingsPage Check Connection button calls the provided live health operation with wrapping label', async () => {
  const settingsSource=readFileSync(path.join(root,'src/desktop/pages/Settings.tsx'),'utf8');
  const compiled=ts.transpileModule(settingsSource,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const lib={exports:{}};
  const jsx=(type,props)=>({type:typeof type==='function'?(type.displayName||type.name):type,props:props??{}});
  const icon=()=>({});
  function imported(name) {
    if(name==='react')return {default:{useState:(initial)=>[initial,()=>{}]},useState:(initial)=>[initial,()=>{}]};
    if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};
    if(name==='lucide-react')return new Proxy({}, {get:()=>icon});
    if(name==='../../components/ui')return Object.fromEntries(['Button','Card','CopyButton','ErrorState','Field','Input','StatusBadge','StatusDot'].map(x=>[x,x]));
    if(name==='../ui')return {SettingsSection:'SettingsSection'};
    if(name==='../components/ManagerAccountPanel')return {ManagerAccountPanel:'ManagerAccountPanel'};
    if(name==='../../i18n/react')return {useI18n:()=>({t:k=>k,locale:'en'})};
    if(name==='../lib/printers')return {friendlyAgentError:()=>'',friendlyPrinterError:()=>'',labelPrinter:()=>'',printerDisplayStatus:()=>''};
    if(name==='../lib/ipc')return {getAutostart:async()=>false,setAutostart:async()=>{}};
    throw Error('unexpected SettingsPage import '+name);
  }
  new Function('require','module','exports',compiled)(imported,lib,lib.exports);
  let probes=0;
  const defaults={agentStatus:null,runtimePaths:null,pairCode:'',gatewayDraftUrl:'https://gateway.example.test',gatewayUrl:'',gatewayDraftMatchesSaved:false,connectedPrinters:[],printers:[],devices:[],managerAccount:{status:'signed-out',session:null},checkHealth:async()=>{probes++}};
  const state=new Proxy(defaults,{get:(target,key)=>key in target?target[key]:()=>{}});
  const tree=lib.exports.SettingsPage({s:state});
  const visit=(node,predicate)=>{
    if(!node||typeof node!=='object')return [];
    return [...(predicate(node)?[node]:[]),...[node.props?.children].flat(Infinity).flatMap(child=>visit(child,predicate))];
  };
  const buttons=visit(tree,n=>n.type==='Button'&&n.props.children?.type==='span'&&n.props.children?.props?.children==='desktop.settings.checkConnection');
  assert.equal(buttons.length,1,'real Settings page must render one live Check Connection button');
  assert.match(buttons[0].props.children.props.className,/whitespace-normal/);
  await buttons[0].props.onClick();
  assert.equal(probes,1);
});
