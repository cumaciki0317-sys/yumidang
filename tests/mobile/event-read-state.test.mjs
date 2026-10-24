// Exercises real screen hooks with synthetic service responses; no provider or member calls.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
const root = path.resolve(import.meta.dirname, '../../apps/mobile');
const ts = createRequire(path.join(root, 'package.json'))('typescript');
const source = ts.transpileModule(readFileSync(path.join(root, 'src/screens/RemoteScreens.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true, target: ts.ScriptTarget.ES2022 } }).outputText;
const E1 = '10000000-0000-4000-8000-000000000001', E2 = '10000000-0000-4000-8000-000000000002', P1 = '20000000-0000-4000-8000-000000000001';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const text = n => Array.isArray(n) ? n.map(text).join('') : typeof n === 'string' ? n : n?.props?.children?.map(text).join('') ?? '';
const nodes = n => Array.isArray(n) ? n.flatMap(nodes) : n && typeof n === 'object' ? [n,...(n.props?.children??[]).flatMap(nodes)] : [];
const post = (id=P1) => ({ id,title:'합성 동행',state:'recruiting',cost:{kind:'free'},authorDisplayName:null,publicArea:'서울특별시 종로구 사직동',startsAt:'2026-11-01T01:00:00Z',endsAt:'2026-11-01T02:00:00Z' });
function harness(kind, service, initialProps) {
  const slots=[], pending=[], calls=[], routes=[]; let index=0, dirty=false, tree, epoch=0, focused=true, props=initialProps;
  const react={
    createElement(type,props,...children){return {type,props:{...props,children}};},
    useState(initial){const key=index++;if(!(key in slots))slots[key]=typeof initial==='function'?initial():initial;return [slots[key],next=>{const val=typeof next==='function'?next(slots[key]):next;if(!Object.is(val,slots[key])){slots[key]=val;dirty=true;}}];},
    useRef(initial){const key=index++;if(!(key in slots))slots[key]={current:initial};return slots[key];},
    useCallback(callback,deps){const key=index++,prev=slots[key];if(!prev||deps.some((x,i)=>!Object.is(x,prev.deps[i])))slots[key]={callback,deps};return slots[key].callback;},
    useEffect(effect,deps){const key=index++,prev=slots[key];if(!prev||deps.some((x,i)=>!Object.is(x,prev.deps[i])))pending.push(()=>{prev?.cleanup?.();slots[key]={deps,cleanup:effect()};});},
  };
  class ApiError extends Error {constructor(status,code){super(code);this.status=status;this.code=code;}}
  const servicePort=new Proxy(service,{get(target,key){if(typeof target[key]!=='function')return target[key];return (...args)=>{calls.push({method:key,args});return target[key](...args);};}});
  const exports={};
  vm.runInNewContext(source,{exports,AbortController,Date,Intl,require(id){
    if(id==='react')return react;
    if(id==='react-native')return {View:'View',Linking:{}};
    if(id==='expo-router')return {useFocusEffect(cb){react.useEffect(()=>focused?cb():undefined,[cb,focused]);},router:{push:route=>routes.push(route)}};
    if(id==='../api')return {ApiError};
    if(id==='../remote')return {useService:()=>servicePort,useServiceSession:()=>({epoch,authenticated:epoch>0}),serviceSessionEpoch:()=>epoch};
    if(id==='../state')return {useApp:()=>({navigate:(...args)=>routes.push(args)})};
    if(id==='../ui')return Object.fromEntries(['Badge','Body','Button','Card','Chip','Empty','Field','Row','Screen','TextButton','Title'].map(x=>[x,x]));
    if(id==='../presentation/client-feedback')return {RecoveryCard:'RecoveryCard',recoveryKind:e=>e?.status===401?'login':e?.status===403?'unavailable':'retry'};
    if(id==='../presentation/events/EventPresentation')return {EventListCard:'EventListCard',EventDetailContent:'EventDetailContent'};
    if(id==='./RemoteMemberScreens')return {useMemberResource:()=>({data:false}),RemoteReport:'RemoteReport'};
    if(id==='../presentation/ux-time')return {formatKoreanDateTime:x=>x};
    return {};
  }});
  const component=exports[kind];
  const render=()=>{index=0;dirty=false;tree=component(props);pending.splice(0).forEach(run=>run());};
  async function flush(){for(let i=0;i<12;i++){if(dirty)render();await new Promise(r=>setImmediate(r));if(!dirty)return;}throw Error('not settled');}
  render();
  return {flush,calls,routes,ApiError,exports,get tree(){return tree;},find(type,label){return nodes(tree).find(n=>n.type===type&&(label===undefined||text(n)===label));},all(type){return nodes(tree).filter(n=>n.type===type);},update(next){props={...props,...next};render();},session(){epoch++;render();},blur(){focused=false;render();},focus(){focused=true;render();}};
}

test('linked posts start with exact eventId, all states, no main-list filters; pagination keeps applied event/filter',async()=>{
  const h=harness('RemoteEventPosts',{async searchEventPosts(id,recruiting,cursor){return {posts:[post(cursor?E2:P1)],nextCursor:cursor?null:'page2'};}},{eventId:E1});
  await h.flush();assert.deepEqual(h.calls[0].args.slice(0,3),[E1,false,undefined]);
  await h.find('Button','공고 10개 더 보기').props.onPress();await h.flush();
  assert.deepEqual(h.calls[1].args.slice(0,3),[E1,false,'page2']);assert.equal(h.all(h.exports.RemotePostCard).length,2);
  h.find('Chip','모집 중').props.onPress();await h.flush();assert.deepEqual(h.calls.at(-1).args.slice(0,3),[E1,true,undefined]);assert.equal(h.all(h.exports.RemotePostCard).length,1);
});
test('zero results are distinct from missing server support and retry retains filter',async()=>{
  let fail=true;const h=harness('RemoteEventPosts',{async searchEventPosts(){if(fail)throw Error('server filter not ready');return {posts:[],nextCursor:null};}},{eventId:E1});await h.flush();
  assert.equal(h.find('Empty'),undefined);assert.ok(h.find('RecoveryCard'));assert.match(text(h.tree),/확인하지 못했어요/);
  fail=false;h.find('RecoveryCard').props.onRetry();await h.flush();assert.equal(h.find('Empty').props.title,'아직 이 행사에 등록된 동행 공고가 없어요');
  h.find('Chip','모집 중').props.onPress();await h.flush();assert.equal(h.find('Empty').props.title,'이 행사에 모집 중인 동행 공고가 없어요');
});
test('additional page failure preserves current rows and retries the same cursor without duplicate calls',async()=>{
  let attempt=0,resolve;const h=harness('RemoteEventPosts',{async searchEventPosts(_id,_r,cursor){if(!cursor)return {posts:[post()],nextCursor:'page2'};attempt++;if(attempt===1)throw Error('network');return new Promise(r=>{resolve=r;});}},{eventId:E1});await h.flush();
  await h.find('Button').props.onPress();await h.flush();assert.equal(h.all(h.exports.RemotePostCard).length,1);assert.match(text(h.tree),/추가 공고를 불러오지/);
  const retry=h.find('RecoveryCard').props.onRetry;retry();retry();await h.flush();assert.equal(attempt,2);
  resolve({posts:[post(E2)],nextCursor:null});await h.flush();assert.equal(h.all(h.exports.RemotePostCard).length,2);
});
test('filter and event changes abort pending loads and ignore late results',async()=>{
  const old=deferred();const h=harness('RemoteEventPosts',{async searchEventPosts(id,r){if(id===E1&&!r)return old.promise;return {posts:[post(E2)],nextCursor:null};}},{eventId:E1});await h.flush();
  h.find('Chip','모집 중').props.onPress();await h.flush();assert.equal(h.calls[0].args[3].aborted,true);
  old.resolve({posts:[post()],nextCursor:null});await h.flush();assert.equal(h.all(h.exports.RemotePostCard)[0].props.post.id,E2);
  h.update({eventId:E2});await h.flush();assert.equal(h.calls.at(-1).args[0],E2);
});
test('old load-more callback cannot issue a request after session changes or blur',async()=>{
  const h=harness('RemoteEventPosts',{async searchEventPosts(){return {posts:[post()],nextCursor:'page2'};}},{eventId:E1});await h.flush();const oldMore=h.find('Button').props.onPress;
  h.session();await h.flush();const count=h.calls.length;await oldMore();await h.flush();assert.equal(h.calls.length,count);
  const blurredMore=h.find('Button').props.onPress;h.blur();await h.flush();await blurredMore();await h.flush();assert.equal(h.calls.length,count);assert.equal(h.all(h.exports.RemotePostCard).length,0);
});
test('permission failure on additional page clears previously displayed cards',async()=>{
  let error;const h=harness('RemoteEventPosts',{async searchEventPosts(_id,_r,cursor){if(cursor)throw error;return {posts:[post()],nextCursor:'page2'};}},{eventId:E1});error=new h.ApiError(403,'FORBIDDEN');await h.flush();await h.find('Button').props.onPress();await h.flush();assert.equal(h.all(h.exports.RemotePostCard).length,0);assert.equal(h.find('RecoveryCard').props.kind,'unavailable');assert.equal(h.find('Empty'),undefined);
});
test('manual event details are inline and have no independent event navigation',async()=>{
  const h=harness('RemotePostEventLink',{async getPostEventLink(){return {postId:P1,eventLinkState:'manual',manualEvent:{title:'합성 클래스',placeName:'공개 행사장',publicAddress:'공개 주소',publicAddressConfirmed:true},eventId:null,linkedEvent:null};}},{postId:P1});await h.flush();assert.match(text(h.tree),/합성 클래스/);assert.match(text(h.tree),/공개 행사장/);assert.equal(h.find('EventListCard'),undefined);assert.equal(h.find('TextButton'),undefined);
});
test('hidden source shows neutral notice without leaking original event fields or route',async()=>{
  const h=harness('RemotePostEventLink',{async getPostEventLink(){return {postId:P1,eventLinkState:'hidden',eventId:E1,manualEvent:null,linkedEvent:null};}},{postId:P1});await h.flush();assert.match(text(h.tree),/행사 취소를 의미하지는/);assert.equal(h.find('EventListCard'),undefined);assert.equal(h.find('TextButton').props.children[0],'행사 정보 다시 확인');
});
test('linked source comes only from extension; blur/reload failure removes previous values',async()=>{
  let fail=false;const h=harness('RemotePostEventLink',{async getPostEventLink(){if(fail)throw Error('network');return {postId:P1,eventLinkState:'linked',eventId:E1,manualEvent:null,linkedEvent:{id:E1,title:'공개 원천'}};}},{postId:P1});await h.flush();assert.equal(h.find('EventListCard').props.event.title,'공개 원천');h.find('TextButton','행사 정보 보기').props.onPress();assert.deepEqual(h.routes[0],['S09-3',E1]);
  h.blur();await h.flush();fail=true;h.focus();await h.flush();assert.equal(h.find('EventListCard'),undefined);assert.ok(h.find('RecoveryCard'));assert.match(text(h.tree),/공고와 동행 약속은 유지/);
});
test('post detail uses isolated authoritative event extension while keeping post content and anonymous mask',async()=>{
  const h=harness('RemotePostDetail',{async getPost(){return {...post(),postId:P1,description:'공고 본문',category:'공연',status:'recruiting',updatedAt:'v1',eventId:E1,linkedEvent:{title:'obsolete source'},authorDisplayName:null};}},{id:P1});await h.flush();assert.match(text(h.tree),/공고 본문/);assert.match(text(h.tree),/동행인은 로그인 후/);assert.doesNotMatch(text(h.tree),/obsolete source/);assert.equal(h.all(h.exports.RemotePostEventLink).length,1);
});
