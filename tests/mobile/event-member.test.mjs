import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
const appRoot=path.resolve(import.meta.dirname,'../../apps/mobile');
const ts=createRequire(path.join(appRoot,'package.json'))('typescript');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function nodes(value){return Array.isArray(value)?value.flatMap(nodes):value&&typeof value==='object'?[value,...nodes(value.props?.children??[])]:[];}
function words(value){return Array.isArray(value)?value.map(words).join(''):typeof value==='string'?value:value&&typeof value==='object'?words(value.props?.children??[]):'';}
const ui=Object.fromEntries(['Body','Button','Card','Chip','Empty','Field','Row','Screen','TextButton','Title'].map(k=>[k,k]));
function compile(file,require,tail=''){const exports={};vm.runInNewContext(ts.transpileModule(readFileSync(path.join(appRoot,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText+tail,{exports,require,AbortController,Date,Intl,Map,Set,console,TextEncoder});return exports;}
const manual={title:'합성 직접 행사',placeName:'공개 공연장',publicAddress:'',publicAddressConfirmed:false};
const post=()=>({postId:'post',title:'원래 공고',description:'원래 소개',category:'공연',startsAt:'2026-10-26T10:00:00Z',endsAt:'2026-10-26T11:00:00Z',recruitmentEndsAt:'2026-10-26T09:00:00Z',updatedAt:'2026-10-23T00:00:00Z',publicArea:'서울특별시 중구 명동',privateDetails:{registeredPlaceName:'공연장',registeredAddress:'서울 공개 주소',meetingDetail:'만남 지점'},preferenceNote:null,tags:[],costType:'free',amount:0,status:'closed',eventId:null});
const link=()=>({postId:'post',eventId:null,manualEvent:manual,linkedEvent:null,eventLinkState:'manual'});
const proposal=()=>({changeKind:'event',changeId:'change',conditionVersion:'version',eventFingerprint:'a'.repeat(64),status:'awaiting_response',requestedByMe:false,expiresAt:'2026-10-25T00:00:00Z',newEventInput:{eventId:null,manualEvent:manual},newLinkedEvent:null});
function harness(kind='editor',{member={},publicService={},initialProposal=proposal(),initialLink=link(),initialPost=post(),now=Date.parse('2026-10-24T00:00:00Z')}={}){
 const slots=[],effects=[];let cursor=0,dirty=false,focused=true,value,epoch=1,sequence=0,prop=initialProposal;
 const navigations=[],toasts=[],calls=[];
 const api=compile('src/api.ts',()=>({}));
 const service={ownsPost:async()=>true,appointments:async()=>[],changeState:async()=>({change:null}),update:async(...args)=>{calls.push(['update',...args]);return {postId:'post',status:'recruiting'};},changeAction:async(...args)=>{calls.push(['changeAction',...args]);return {};},acceptEventChange:async(...args)=>{calls.push(['acceptEventChange',...args]);return {};},...member};
 const pub={getPost:async()=>initialPost,getPostEventLink:async()=>initialLink,getEvent:async()=>({sourceStatus:'active',state:'upcoming'}),...publicService};
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
 const effect=(create,deps,focus=false)=>{const i=cursor++,old=slots[i];if(!old||!same(old.deps,deps))effects.push(()=>{old?.cleanup?.();const row={deps,create,focus};slots[i]=row;if(!focus||focused)row.cleanup=create();});};
 const React={createElement(type,props,...children){return {type,props:{...props,children}};},useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return [slots[i],next=>{const v=typeof next==='function'?next(slots[i]):next;if(!Object.is(v,slots[i])){slots[i]=v;dirty=true;}}];},useRef(initial){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];},useCallback(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={fn,deps};return slots[i].fn;},useEffect:create=>{},useLayoutEffect:create=>{}};
 React.useEffect=(c,d)=>effect(c,d);React.useLayoutEffect=React.useEffect;
 const exports=compile('src/screens/RemoteMemberScreens.tsx',id=>{
  if(id==='react')return React;
  if(id==='react-native')return Object.fromEntries(['FlatList','Image','Modal','Pressable','ScrollView','View'].map(k=>[k,k]));
  if(id==='expo-router')return {useFocusEffect(c){effect(c,[c],true);}};
  if(id==='../remote')return {useService:()=>pub,useMemberService:()=>service,useServiceSession:()=>({epoch,authenticated:true}),serviceSessionEpoch:()=>epoch};
  if(id==='../state')return {useApp:()=>({now,navigate:(...a)=>navigations.push(a),showToast:t=>toasts.push(t)})};
  if(id==='../api')return api;
  if(id==='../ui')return ui;
  if(id==='expo-crypto')return {randomUUID:()=>`intent-${++sequence}`};
  if(id==='./RemoteEventEditor')return {RemoteEventEditor:'RemoteEventEditor'};
  if(id==='../presentation/events/EventPresentation')return {EventDetailContent:'EventDetailContent'};
  if(id==='../presentation/events/event-selection')return {canSelectEvent:e=>e.sourceStatus==='active'&&['ongoing','upcoming'].includes(e.state)};
  if(id==='../presentation/events/event-draft')return {manualEventError:v=>v.title?'': '행사명 필요'};
  if(id==='../presentation/ux-time')return {formatDeadline:()=>'',formatKoreanDateTime:x=>x};
  return {};
 },'\nexports.testEditor=PostEditor;exports.testProposal=AppointmentEventProposal;exports.testConditions=ConsentConditions;exports.testLink=EventLinkContent;');
 const render=()=>{cursor=0;dirty=false;value=kind==='editor'?exports.testEditor({id:'post'}):kind==='proposal'?exports.testProposal({appointmentId:'appointment',postId:'post',proposal:prop,onChanged(){calls.push(['refresh']);}}):kind==='conditions'?exports.testConditions({conditions:{title:'공고',manualEvent:manual}}):exports.testLink({link:initialLink});effects.splice(0).forEach(f=>f());};
 async function flush(){for(let i=0;i<40;i++){if(dirty)render();await new Promise(r=>setImmediate(r));if(!dirty&&!effects.length)return;}throw Error('did not settle');}
 render();return {flush,render,api,calls,service,pub,navigations,toasts,exports,get value(){return value;},button(label){return nodes(value).find(n=>['Button','TextButton'].includes(n.type)&&words(n)===label);},field(label){return nodes(value).find(n=>n.type==='Field'&&n.props.label===label);},picker(){return nodes(value).find(n=>n.type==='RemoteEventEditor');},changeSession(){epoch++;dirty=true;},setProposal(p){prop=p;dirty=true;},blur(){focused=false;for(const s of slots)if(s?.focus)s.cleanup?.();},unmount(){for(const s of slots)s?.cleanup?.();}};
}
test('editing a source-linked post preserves omitted event keys and binds operation ID',async()=>{
 const h=harness('editor',{initialPost:{...post(),eventId:'source'},initialLink:{...link(),eventId:'source',manualEvent:null,linkedEvent:{title:'원천'},eventLinkState:'linked'}});await h.flush();h.field('제목').props.onChangeText('수정 제목');await h.flush();h.button('공고 수정 저장').props.onPress();await h.flush();const c=h.calls.find(c=>c[0]==='update');assert.equal(c[2].title,'수정 제목');assert.equal(Object.hasOwn(c[2],'eventId'),false);assert.equal(Object.hasOwn(c[2],'manualEvent'),false);assert.equal(c[3],post().updatedAt);assert.equal(c[5],'intent-1');
});
test('explicit remove sends both null while a manual replacement sends exact input',async()=>{
 for(const choice of [{eventId:null,manualEvent:null},{eventId:null,manualEvent:{...manual,title:'새 행사'}}]){const h=harness();await h.flush();h.picker().props.onChange(choice);await h.flush();h.button('공고 수정 저장').props.onPress();await h.flush();const c=h.calls.find(c=>c[0]==='update');assert.equal(c[2].eventId,null);assert.deepEqual(c[2].manualEvent,choice.manualEvent);}
});
test('event-link failure never creates an empty editor or permits saving',async()=>{
 const h=harness('editor',{publicService:{getPostEventLink:async()=>{throw new Error('unavailable');}}});await h.flush();assert.equal(h.picker(),undefined);assert.equal(h.button('공고 수정 저장'),undefined);assert.equal(h.calls.length,0);
});
test('source selection is checked immediately before save and unavailable event prevents mutation',async()=>{
 let reads=0;const h=harness('editor',{publicService:{getEvent:async()=>{reads++;return {sourceStatus:'cancelled',state:'upcoming'};}}});await h.flush();h.picker().props.onChange({eventId:'source',manualEvent:null});await h.flush();h.button('공고 수정 저장').props.onPress();await h.flush();assert.equal(reads,1);assert.equal(h.calls.length,0);assert.equal(h.picker().props.value.eventId,'source');
});
test('account change during event recheck cannot write under the replacement session',async()=>{
 const wait=deferred();const h=harness('editor',{publicService:{getEvent:async()=>wait.promise}});await h.flush();h.picker().props.onChange({eventId:'source',manualEvent:null});await h.flush();h.button('공고 수정 저장').props.onPress();await h.flush();h.changeSession();await h.flush();wait.resolve({sourceStatus:'active',state:'upcoming'});await h.flush();assert.equal(h.calls.length,0);
});
test('a saved stale submit handler cannot write after account replacement',async()=>{
 const h=harness();await h.flush();const old=h.button('공고 수정 저장');h.changeSession();await h.flush();old.props.onPress();await h.flush();assert.equal(h.calls.length,0);
});
test('confirmed appointment derives event-only proposal from current full post fields',async()=>{
 const h=harness('editor',{member:{appointments:async()=>[{appointment_id:'appointment',post_id:'post',my_role:'author',status:'confirmed'}],update:async(...args)=>{h.calls.push(['update',...args]);return {status:'event_change_pending'};}}});await h.flush();assert.equal(h.field('제목').props.editable,false);h.field('제목').props.onChangeText('금지 변경');await h.flush();h.picker().props.onChange({eventId:null,manualEvent:{...manual,title:'새 행사'}});await h.flush();h.button('행사 변경 제안 보내기').props.onPress();await h.flush();const c=h.calls.find(c=>c[0]==='update');assert.equal(c[2].title,post().title);assert.equal(c[2].eventChangeId,'intent-1');assert.equal(c[2].manualEvent.title,'새 행사');assert.equal(h.navigations.length,0);assert.match(words(h.value),/상대가 수락하기 전/);assert.equal(h.button('행사 변경 제안 보내기').props.disabled,true);
});
test('a cancelled historical appointment does not force event-only editing',async()=>{
 const h=harness('editor',{member:{appointments:async()=>[{appointment_id:'old',post_id:'post',my_role:'author',status:'cancelled'}]}});await h.flush();assert.equal(h.field('제목').props.editable,true);assert.ok(h.button('공고 수정 저장'));
});
test('event proposal lost response retries same ID and terminal response never claims pending',async()=>{
 let writes=0;const h=harness('editor',{member:{appointments:async()=>[{appointment_id:'appointment',post_id:'post',my_role:'author',status:'confirmed'}],update:async(...args)=>{h.calls.push(['update',...args]);if(++writes===1)throw new Error('lost');return {status:'event_change_declined'};}}});await h.flush();h.picker().props.onChange({eventId:null,manualEvent:null});await h.flush();h.button('행사 변경 제안 보내기').props.onPress();await h.flush();h.button('행사 변경 제안 보내기').props.onPress();await h.flush();const calls=h.calls.filter(c=>c[0]==='update');assert.equal(calls[0][2].eventChangeId,calls[1][2].eventChangeId);assert.match(words(h.value),/거절됐어요/);assert.equal(h.toasts.some(t=>t.includes('제안했어요')),false);
});
test('event-specific acceptance sends displayed fingerprint and never calls date accept',async()=>{
 const h=harness('proposal');await h.flush();h.button('이 행사 변경 수락').props.onPress();await h.flush();assert.equal(h.calls[0][0],'acceptEventChange');assert.equal(h.calls[0][4],'a'.repeat(64));assert.equal(h.calls.some(c=>c[0]==='changeAction'),false);
});
test('hidden proposed source or missing current event prevents informed acceptance',async()=>{
 const h=harness('proposal',{initialProposal:{...proposal(),newEventInput:{eventId:'hidden-source',manualEvent:null}}});await h.flush();assert.equal(h.button('이 행사 변경 수락').props.disabled,true);h.button('이 행사 변경 수락').props.onPress();await h.flush();assert.equal(h.calls.length,0);
 const fail=harness('proposal',{publicService:{getPostEventLink:async()=>{throw new Error('no current event');}}});await fail.flush();assert.equal(fail.button('이 행사 변경 수락').props.disabled,true);fail.button('행사 변경 거절').props.onPress();await fail.flush();assert.equal(fail.calls[0][0],'changeAction');assert.equal(fail.calls[0][2],'decline');
});
test('changed proposal invalidates an already-rendered acceptance callback',async()=>{
 const h=harness('proposal');await h.flush();const stale=h.button('이 행사 변경 수락');h.setProposal({...proposal(),eventFingerprint:'b'.repeat(64)});await h.flush();stale.props.onPress();await h.flush();assert.equal(h.calls.length,0);h.button('이 행사 변경 수락').props.onPress();await h.flush();assert.equal(h.calls[0][4],'b'.repeat(64));
});
test('expired event change has no live acceptance even at exact deadline',async()=>{
 const p=proposal();const h=harness('proposal',{initialProposal:p,now:Date.parse(p.expiresAt)});await h.flush();assert.equal(h.button('이 행사 변경 수락').props.disabled,true);h.button('이 행사 변경 수락').props.onPress();await h.flush();assert.equal(h.calls.length,0);
});
test('confirmed conditions include direct event name and public address',()=>{
 const h=harness('conditions');assert.match(words(h.value),/직접 입력 행사 · 합성 직접 행사/);assert.match(words(h.value),/공개 공연장/);
});
test('hidden event card suppresses stale source fields even when accidentally present',()=>{
 const h=harness('link',{initialLink:{...link(),eventLinkState:'hidden',eventId:'source',manualEvent:null,linkedEvent:{title:'원천 비공개'}}});assert.match(words(h.value),/행사 취소를 의미하지는/);assert.doesNotMatch(words(h.value),/원천 비공개/);assert.equal(nodes(h.value).some(n=>n.type==='EventDetailContent'),false);
});

test('unchanged direct event stays in the inspected ordinary update input',async()=>{
 const h=harness();await h.flush();h.field('제목').props.onChangeText('일반 수정');await h.flush();h.button('공고 수정 저장').props.onPress();await h.flush();const c=h.calls.find(c=>c[0]==='update');assert.equal(c[2].eventId,null);assert.deepEqual(c[2].manualEvent,manual);assert.ok(c[5]);
});

test('lost source event update retrieves same intent without new preflight blocking receipt',async()=>{
 let reads=0,writes=0;const h=harness('editor',{publicService:{getEvent:async()=>{reads++;return {sourceStatus:reads===1?'active':'cancelled',state:'upcoming'};}},member:{update:async(...args)=>{h.calls.push(['update',...args]);if(++writes===1)throw Error('lost');return {status:'recruiting'};}}});
 await h.flush();h.picker().props.onChange({eventId:'source',manualEvent:null});await h.flush();h.button('공고 수정 저장').props.onPress();await h.flush();h.button('공고 수정 저장').props.onPress();await h.flush();assert.equal(reads,1);assert.equal(writes,2);assert.equal(h.calls[0][5],h.calls[1][5]);
});
