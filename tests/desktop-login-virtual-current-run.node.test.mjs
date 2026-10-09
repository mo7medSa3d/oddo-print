// Live desktop Settings and printer diagnostics: deliberately no Manager sign-in.
// The Windows service elevation dialog is unrelated and stays covered elsewhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const require=createRequire(import.meta.url);
const ts=require('typescript');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

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
    if(name==='../../i18n/react')return {useI18n:()=>({t:k=>k,locale:'en'})};
    if(name==='../lib/printers')return {friendlyAgentError:()=>'',friendlyPrinterError:()=>'',labelPrinter:()=>'',printerDisplayStatus:()=>''};
    if(name==='../lib/ipc')return {getAutostart:async()=>false,setAutostart:async()=>{}};
    throw Error('unexpected SettingsPage import '+name);
  }
  new Function('require','module','exports',compiled)(imported,lib,lib.exports);
  let probes=0;
  const defaults={agentStatus:null,runtimePaths:null,pairCode:'',gatewayDraftUrl:'https://gateway.example.test',gatewayUrl:'',gatewayDraftMatchesSaved:false,connectedPrinters:[],printers:[],devices:[],checkHealth:async()=>{probes++}};
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
