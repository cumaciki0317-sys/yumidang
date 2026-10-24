import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
const root=path.resolve(import.meta.dirname,'../../apps/mobile');
const ts=createRequire(path.join(root,'package.json'))('typescript');
const compile=p=>ts.transpileModule(readFileSync(path.join(root,'src',p),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText;
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const initial={exploration:false,summary_view:true,summary_generate:true,summary_source:true};
function nodes(v){if(Array.isArray(v))return v.flatMap(nodes);return v&&typeof v==='object'&&'type'in v?[v,...Object.values(v.props||{}).flatMap(nodes)]:[];}
function text(v){return typeof v==='string'?v:Array.isArray(v)?v.map(text).join(''):v?.props?text(v.props.children):'';}
function harness(options={}){
 let slots=[],cursor=0,effects=[],dirty=false,tree,epoch=1,revision=0,pending=false; const listeners=new Set();
 const react={createElement:(type,props,...children)=>({type,props:{...props,children}}),useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],next=>{const value=typeof next==='function'?next(slots[i]):next;if(!Object.is(slots[i],value)){slots[i]=value;dirty=true;}}];},useRef(initial){const i=cursor++;return slots[i]??=( {current:initial});},useCallback(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((x,n)=>!Object.is(x,old.deps[n])))slots[i]={fn,deps};return slots[i].fn;},useEffect(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((x,n)=>!Object.is(x,old.deps[n])))effects.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:fn()};});}};
 let server={...initial};const writes=[],reads=[];let summaryCalls=0;
 const service={async aiConsents(signal){reads.push(signal);return options.read?options.read():{...server};},async setAiConsent(kind,allowed,signal){writes.push({kind,allowed,signal});if(options.write)return options.write(kind,allowed,server);server[kind]=allowed;return{...server};}};
 const summaryService={profileSummary:async()=>{summaryCalls++;return options.summaryRead?options.summaryRead():{summary:{text:'서버 요약'}};}};
 const ui=Object.fromEntries(['Body','Button','Card','TextButton','Title'].map(n=>[n,n]));
 const exports={}; vm.runInNewContext(compile(options.summary?'screens/RemoteScreens.tsx':'presentation/member-ai-consents.tsx'),{exports,AbortController,Date,Intl,require(name){
 if(name==='react')return react;if(name==='react-native')return {View:'View'};
 if(name==='expo-router')return {useFocusEffect:fn=>react.useEffect(fn,[fn])};
 if(name.endsWith('/remote'))return {useMemberService:()=>service,useServiceSession:()=>({epoch,authenticated:true}),serviceSessionEpoch:()=>epoch,useService:()=>summaryService};
 if(name.endsWith('/ui'))return ui;
 if(name.endsWith('/ai-consent-state'))return {aiConsentRevision:()=>revision,aiConsentMutationPending:()=>pending,subscribeAiConsentChange(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
 if(name.endsWith('/api'))return {ApiError:class ApiError extends Error{}};return {};
 }});
 const render=()=>{cursor=0;dirty=false;tree=options.summary?exports.RemoteProfileSummary({id:'profile'}):exports.MemberAiConsentSettings();effects.splice(0).forEach(fn=>fn());};
 const flush=async()=>{for(let i=0;i<20;i++){if(dirty)render();await new Promise(r=>setImmediate(r));if(!dirty)return;}throw Error('did not settle');};
 render();return {writes,reads,flush,get tree(){return tree;},get text(){return text(tree);},get summaryCalls(){return summaryCalls;},find(label){return nodes(tree).find(n=>['Button','TextButton'].includes(n.type)&&text(n)===label);},changeSession(){epoch++;dirty=true;},invalidate(mutationPending){pending=mutationPending;revision++;listeners.forEach(fn=>fn());},leave(){for(const slot of slots)slot?.cleanup?.();}};
}
test('settings display server-confirmed independent values and a single withdrawal changes only its kind',async()=>{
 const h=harness();await h.flush();h.find('내 프로필 요약 생성·노출 동의 철회').props.onPress();await h.flush();assert.equal(h.writes.length,0);
 h.find('철회 확인').props.onPress();await h.flush();assert.deepEqual(h.writes.map(({kind,allowed})=>({kind,allowed})),[{kind:'summary_generate',allowed:false}]);
 assert.ok(h.find('후기 요약 열람 동의 철회'));assert.ok(h.find('내가 작성한 후기의 요약 활용 동의 철회'));assert.ok(h.find('내 프로필 요약 생성·노출 동의하기'));
});
test('unknown consent read never invents false values or allows a write',async()=>{
 const h=harness({read:async()=>{throw Error('offline');}});await h.flush();assert.match(h.text,/상태 확인 필요/);assert.equal(h.find('후기 요약 열람 동의하기').props.disabled,true);assert.equal(h.writes.length,0);
});
test('lost mutation response re-reads actual state and never rolls a confirmed change back optimistically',async()=>{
 const h=harness({write:async(kind,allowed,server)=>{server[kind]=allowed;throw Error('lost');}});await h.flush();h.find('후기 요약 열람 동의 철회').props.onPress();await h.flush();h.find('철회 확인').props.onPress();await h.flush();
 assert.match(h.text,/서버에서 다시 확인한 현재 상태/);assert.ok(h.find('후기 요약 열람 동의하기'));assert.equal(h.reads.length,2);
});
test('late consent reads cannot populate a replacement session or a departed screen',async()=>{
 const late=deferred(),h=harness({read:()=>late.promise});h.changeSession();await h.flush();h.leave();late.resolve({...initial});await h.flush();assert.match(h.text,/상태 확인 필요/);
});
test('summary text is hidden during a consent mutation and a late old response stays hidden',async()=>{
 const late=deferred(),h=harness({summary:true,summaryRead:()=>late.promise});await h.flush();const before=h.summaryCalls;h.invalidate(true);await h.flush();late.resolve({summary:{text:'철회 이전 요약'}});await h.flush();assert.ok(!h.text.includes('철회 이전 요약'));assert.equal(h.summaryCalls,before);
 h.invalidate(false);await h.flush();assert.equal(h.summaryCalls,before+1);
});
test('a withdrawal confirmation or stale button from an old account cannot write the replacement account',async()=>{
 const h=harness();await h.flush();h.find('후기 요약 열람 동의 철회').props.onPress();await h.flush();
 const staleConfirm=h.find('철회 확인').props.onPress;h.changeSession();await h.flush();
 assert.equal(h.find('철회 확인'),undefined);staleConfirm();await h.flush();assert.equal(h.writes.length,0);
});
test('leaving a profile prevents a late summary from restoring cleared private text',async()=>{
 const late=deferred(),h=harness({summary:true,summaryRead:()=>late.promise});await h.flush();h.leave();late.resolve({summary:{text:'화면 밖 지연 요약'}});await h.flush();assert.ok(!h.text.includes('화면 밖 지연 요약'));
});
