/** 기본 Auth는 합성 bridge. 서명 모드는 실제 로컬 Auth/REST와 합성 모델을 쓴다. AI24는 실행 전 NOT_RUN. */
import assert from 'node:assert/strict';
import {readFileSync,lstatSync,openSync,fstatSync,closeSync,fsyncSync,writeSync,mkdirSync,chmodSync,readdirSync,realpathSync,constants} from 'node:fs';
import {dirname,resolve,relative,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
let file:string;
const directEntry=typeof process.argv[1]==='string'&&pathToFileURL(realpathSync(resolve(process.argv[1]))).href===import.meta.url;
if(directEntry){file=process.argv[2];{
const file=process.argv[2],mode=process.argv[3],info=lstatSync(file),directory=lstatSync(dirname(file));
assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.nlink===1&&info.uid===process.getuid!()&&(info.mode&0o777)===0o600);
assert.ok(directory.isDirectory()&&!directory.isSymbolicLink()&&directory.uid===process.getuid!()&&(directory.mode&0o777)===0o700);
const fixtureFd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);let fixtureBytes:Buffer;
try{
 const opened=fstatSync(fixtureFd);
 assert.ok(opened.isFile()&&opened.nlink===1&&opened.uid===process.getuid!()&&(opened.mode&0o777)===0o600&&opened.size<=2*1024*1024);
 assert.equal(opened.dev,info.dev);assert.equal(opened.ino,info.ino);
 fixtureBytes=readFileSync(fixtureFd);const after=fstatSync(fixtureFd),current=lstatSync(file);
 assert.equal(fixtureBytes.length,opened.size);assert.equal(after.size,opened.size);
 assert.equal(after.mtimeMs,opened.mtimeMs);assert.equal(after.ctimeMs,opened.ctimeMs);
 assert.equal(current.dev,opened.dev);assert.equal(current.ino,opened.ino);
}finally{closeSync(fixtureFd);}
const fixture=JSON.parse(fixtureBytes!.toString('utf8')),origin=new URL(fixture.origin);
assert.equal(origin.hostname,'127.0.0.1');assert.equal(origin.protocol,'http:');assert.equal(origin.origin,fixture.origin);
assert.ok(['--ai-limits','--ai-caps','--signed-auth-negative','--signed-auth-lifecycle-case','--signed-consent-case','--ai-midnight'].includes(mode));
if(mode==='--ai-midnight')assert.equal(fixture.signedLocalAuth,true);
assert.ok(fixture.productManifest&&Object.keys(fixture.productManifest).length>0);
for(const [relative,expected]of Object.entries(fixture.productManifest)){
 assert.ok(relative.startsWith('backend/supabase/functions/')&&!relative.includes('..'));
 assert.equal(createHash('sha256').update(readFileSync(fixture.codeRoot+'/'+relative)).digest('hex'),expected,'product graph changed');
}
const signedNative=globalThis.fetch;
if(fixture.signedLocalAuth===true)globalThis.fetch=async(input:any,init:RequestInit={})=>{
 const url=new URL(input instanceof Request?input.url:String(input));
 assert.equal(url.origin,fixture.origin);assert.ok(!url.username&&!url.password&&!url.search&&!url.hash);
 assert.ok(url.pathname==='/auth/v1/user'||url.pathname.startsWith('/rest/v1/rpc/'));
 assert.ok(init.method!=='DELETE');return signedNative(input,{...init,redirect:'error'});
};
try { process.stdout.write(JSON.stringify(await (mode==='--signed-consent-case'?consentExecutionBoundary(fixture):mode==='--signed-auth-lifecycle-case'?signedAuthLifecycleCase(fixture):mode==='--signed-auth-negative'?signedAuthNegative(fixture):mode==='--ai-midnight'?aiMidnightHttpCase(fixture):mode==='--ai-limits'?aiLimitsHttpCase(fixture):aiCapsHttpCase(fixture)))); }
catch(error){const code=error instanceof Error&&/^AI_CHECK_[A-Z_]+$/.test(error.message)?error.message:'AI_ISOLATED_FACTORY_FAILED';process.stderr.write(code+'\n');process.exitCode=1;}
finally{if(fixture.signedLocalAuth===true)globalThis.fetch=signedNative;}
}}

async function signedAuthNegative(f:any){
 assert.equal(f.signedLocalAuth,true);
 const {createAiChatRuntime}=await import(pathToFileURL(f.codeRoot+'/backend/supabase/functions/ai-chat/index.ts').href);
 const native=globalThis.fetch;let authReads=0,rpcCalls=0,nativeExternalAttempts=0;
 const env:Record<string,string>={SUPABASE_URL:f.origin,SUPABASE_ANON_KEY:f.anon,SUPABASE_SERVICE_ROLE_KEY:f.service,
  INTERNAL_WORKER_SECRET:'synthetic_ai_http_internal_secret_32_chars',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'5000'};
 const transport=async(input:any,init:RequestInit={})=>{
  const url=new URL(String(input));
  if(url.origin!==f.origin){nativeExternalAttempts++;throw new Error('AI_CHECK_NEGATIVE_EXTERNAL');}
  if(url.pathname!=='/auth/v1/user'){rpcCalls++;throw new Error('AI_CHECK_NEGATIVE_RPC');}
  assert.equal(init.method,'GET');authReads++;return native(input,init);
 };
 const token=f.accounts[0].token,parts=token.split('.');assert.equal(parts.length,3);
 parts[2]=(parts[2][0]==='a'?'b':'a')+parts[2].slice(1);
 const cases:any[]=[];
 for(const [name,bearer,expectedReads]of [['missing',null,0],['malformed','invalid-token',0],['invalid_signature',parts.join('.'),1],['service_principal',f.service,0]]as const){
  const before=authReads,headers:Record<string,string>={'content-type':'application/json'};
  if(bearer!==null)headers.authorization='Bearer '+bearer;
  const handler=createAiChatRuntime((key:string)=>env[key],transport);
  const response=await handler(new Request(f.origin+'/functions/v1/ai-chat',{method:'POST',headers,
   body:JSON.stringify({clientRequestId:randomUUID(),messages:[{role:'user',content:'합성 인증 거절 검사'}]})}));
  const body=await response.json();assert.equal(response.status,401);assert.equal(body.error.code,'AUTH_REQUIRED');
  assert.equal(authReads-before,expectedReads);assert.equal(rpcCalls,0);
  cases.push({case:name,status:'PASS',httpStatus:401,actualAuthReads:expectedReads,rpcCalls:0,providerCalls:0});
 }
 return {status:'PASS',cases,nativeExternalAttempts,expiredBearer:'NOT_RUN',revokedSession:'NOT_RUN',anonymousBearer:'NOT_RUN',memberChanged:'NOT_RUN',differentOriginalContext:'NOT_RUN'};
}

/** 실제 원 토큰 거절 1회. 토큰 발급·logout·ban·수명주기 증명은 고정 Python 포트가 담당한다. */
async function signedAuthLifecycleCase(f:any){
 assert.equal(f.signedLocalAuth,true);assert.equal(f.authLifecycleScenario,true);
 assert.ok(['expiredBearer','revokedSession','anonymousBearer','memberChanged','differentOriginalContext'].includes(f.lifecycleCase));
 assert.equal(typeof f.originalToken,'string');assert.match(f.originalUserId,/^[a-f0-9-]{36}$/);
 const {createAiChatRuntime}=await import(pathToFileURL(f.codeRoot+'/backend/supabase/functions/ai-chat/index.ts').href);
 const native=globalThis.fetch;let authReads=0,rpcCalls=0,providerCalls=0,nativeExternalAttempts=0,authStatus:number|undefined;
 const env:Record<string,string>={SUPABASE_URL:f.origin,SUPABASE_ANON_KEY:f.anon,SUPABASE_SERVICE_ROLE_KEY:f.service,
  INTERNAL_WORKER_SECRET:'synthetic_ai_http_internal_secret_32_chars',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'5000',
  AI_RETENTION_DECISION_ID:'synthetic-fixture-only',AI_COST_EVIDENCE_ID:'synthetic-fixture-only',AI_PROCESSING_LEGAL_DECISION_ID:'synthetic-fixture-only',AI_MEMBER_TRANSMISSION_APPROVAL_ID:'synthetic-fixture-only',AI_BUDGET_LEDGER_ID:f.aiLedgerId,
  POTENS_ACCOUNT_ORDER:'yumi,jonghyun,minkyu,sungho',POTENS_API_KEY_YUMI:'synthetic-ai-yumi',POTENS_API_KEY_JONGHYUN:'synthetic-ai-jonghyun',POTENS_API_KEY_MINKYU:'synthetic-ai-minkyu',POTENS_API_KEY_SUNGHO:'synthetic-ai-sungho',
  POTENS_ACCOUNT_TOKEN_BUDGET:'3200000',POTENS_RESET_TIMEZONE:'Asia/Seoul',POTENS_MODEL:'claude-5-sonnet',POTENS_API_BASE_URL:'https://ai.potens.ai',POTENS_USAGE_INPUT_FIELD:'fixture_input',POTENS_USAGE_OUTPUT_FIELD:'fixture_output',
  AI_CHAT_MAX_MESSAGES:'20',AI_CHAT_MAX_MESSAGE_CHARS:'500',AI_CHAT_MAX_TOTAL_CHARS:'4000',AI_CHAT_MAX_OUTPUT_TOKENS:'800',AI_CHAT_SEARCH_PAGE_SIZE:'10',AI_CHAT_MAX_SEARCH_PAGES:'3',AI_CHAT_RECHECK_MAX_PAGES:'3',AI_CHAT_MAX_RESULT_CARDS:'5',AI_CHAT_MATCH_BATCH_SIZE:'5',AI_CHAT_MAX_MATCH_CALLS:'3',AI_CHAT_MAX_MATCH_MAX_OUTPUT_TOKENS:'600',AI_CHAT_MATCH_MAX_OUTPUT_TOKENS:'600'};
 const transport=async(input:any,init:RequestInit={})=>{
  const url=new URL(input instanceof Request?input.url:String(input));
  if(url.origin!==f.origin){providerCalls++;nativeExternalAttempts++;throw new Error('AI_CHECK_LIFECYCLE_EXTERNAL');}
  if(url.pathname!=='/auth/v1/user'){rpcCalls++;throw new Error('AI_CHECK_LIFECYCLE_RPC');}
  assert.equal(init.method,'GET');assert.equal(new Headers(init.headers).get('authorization'),'Bearer '+f.originalToken);
  assert.equal(new Headers(init.headers).get('apikey'),f.anon);authReads++;
  const response=await native(input,{...init,redirect:'error'});authStatus=response.status;
  if(f.lifecycleCase==='anonymousBearer'){
   const user=await response.clone().json();assert.equal(response.status,200);assert.equal(user.id,f.originalUserId);assert.equal(user.is_anonymous,true);
  }else assert.ok([401,403].includes(response.status));
  return response;
 };
 const handler=createAiChatRuntime((key:string)=>env[key],transport,{privacy:{decisionId:'synthetic-local-only',check:async()=>true},outputLimit:{decisionId:'synthetic-wire-only',apply:(body:any,limit:number)=>({...body,synthetic_max_output_tokens:limit})}});
 const response=await handler(new Request(f.origin+'/functions/v1/ai-chat',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+f.originalToken},
  body:JSON.stringify({clientRequestId:randomUUID(),messages:[{role:'user',content:'합성 인증 수명주기 검사'}],currentFilters:{target:'posts'}})}));
 const result=await response.json();assert.equal(response.status,401);assert.equal(result.error.code,'AUTH_REQUIRED');
 assert.equal(authReads,1);assert.equal(rpcCalls,0);assert.equal(providerCalls,0);assert.equal(nativeExternalAttempts,0);
 return {status:'PASS',case:f.lifecycleCase,httpStatus:401,authHttpStatus:authStatus,actualAuthReads:1,rpcCalls:0,providerCalls:0,nativeExternalAttempts:0,
  originalTokenSha256:createHash('sha256').update(f.originalToken).digest('hex'),actualNaver:'NOT_RUN',externalProvider:'NOT_RUN'};
}

/** 실제 caller는 아직 연결하지 않았다. JSON 근거/flags는 이 경계를 활성화하지 못한다. */
function consentExecutionBoundary(_fixture:unknown){
 return {status:'NOT_RUN',actualCalls:0,scope:'SIGNED_PUBLIC_CONSENT_FACTORY',reason:'REVIEWED_TYPED_ROOT_CALLER_AND_FROZEN_SOURCE_CUSTODY_REQUIRED',
  runtimeSourceCapture:'NOT_PROVEN',actualAuthDatabase:'NOT_RUN',serviceMemberRetirement:'NOT_RUN'};
}

/** JSON은 이 객체나 callback을 만들지 못한다. 실제 target 검증 코드는 별도 root 조립 책임이다. */
type ConsentRootInput={decisionId:string;fixturePath:string;fixtureSha256:string;sourceHead:string;unionSha256:string;
 verifyReady:(capture:Readonly<{capturedRoot:string;sourceHead:string;fixtureSha256:string;unionSha256:string;memberId:string;originalTokenSha256:string;origin:string}>)=>Promise<void>};
const consentRootCallers=new WeakMap<object,ConsentRootInput&{used:boolean}>();let consentCallerActive=false;
const consentFixedRoot='/Users/minkyu/Documents/GitHub/yumidang/.worktrees/minkyu-backend100-20261012';
export class ReviewedConsentRootCaller{
 constructor(input:ConsentRootInput){
  assert.equal(Object.keys(input).sort().join(','),'decisionId,fixturePath,fixtureSha256,sourceHead,unionSha256,verifyReady');
  assert.match(input.decisionId,/^[A-Za-z0-9_.:-]{1,128}$/);assert.equal(typeof input.verifyReady,'function');
  for(const value of[input.fixtureSha256,input.unionSha256])assert.match(value,/^[a-f0-9]{64}$/);
  assert.match(input.sourceHead,/^[a-f0-9]{40}$/);assert.equal(resolve(input.fixturePath),input.fixturePath);assert.ok(input.fixturePath.startsWith('/private/tmp/'));
  consentRootCallers.set(this,{...input,used:false});Object.freeze(this);
 }
}
function consentStableRead(path:string,mode:number,maximum:number){
 const state=lstatSync(path);assert.ok(state.isFile()&&!state.isSymbolicLink()&&state.nlink===1&&state.uid===process.getuid!()&&(state.mode&0o777)===mode&&state.size<=maximum);
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=fstatSync(fd),identity=(v:any)=>[v.dev,v.ino,v.mode,v.uid,v.nlink,v.size,v.mtimeMs,v.ctimeMs];assert.deepEqual(identity(before),identity(state));
  const raw=readFileSync(fd),after=fstatSync(fd),now=lstatSync(path);assert.equal(raw.length,before.size);assert.deepEqual(identity(before),identity(after));assert.deepEqual(identity(after),identity(now));return raw;
 }finally{closeSync(fd);}
}
function consentWriteBytes(path:string,raw:Buffer){
 const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{let offset=0;while(offset<raw.length){const count=writeSync(fd,raw,offset,raw.length-offset);assert.ok(Number.isInteger(count)&&count>0&&count<=raw.length-offset);offset+=count;}fsyncSync(fd);}finally{closeSync(fd);}
 assert.ok(consentStableRead(path,0o600,2097152).equals(raw));
 for(const directory of[dirname(path),dirname(dirname(path))]){const handle=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(handle);}finally{closeSync(handle);}}
}
function consentGit(args:string[]){
 const result=spawnSync('git',['-C',consentFixedRoot,...args],{timeout:15000,maxBuffer:2097152});assert.equal(result.status,0);assert.ok(!result.error);return result.stdout;
}
function consentUnionDigest(map:Record<string,string>){return createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(map).sort(([a],[b])=>a<b?-1:a>b?1:0)))).digest('hex');}
function consentDirectory(path:string,mode:number){const state=lstatSync(path);assert.ok(state.isDirectory()&&!state.isSymbolicLink()&&state.uid===process.getuid!()&&(state.mode&0o777)===mode);assert.equal(realpathSync(path),path);}
function consentCapturedPins(root:string,map:Record<string,string>){
 const actual:string[]=[];
 const walk=(path:string)=>{consentDirectory(path,0o500);for(const name of readdirSync(path).sort()){
  const child=path+'/'+name,state=lstatSync(child);assert.ok(!state.isSymbolicLink());
  if(state.isDirectory())walk(child);else{const key=relative(root,child).split(sep).join('/');assert.ok(Object.hasOwn(map,key));
   assert.equal(createHash('sha256').update(consentStableRead(child,0o400,1048576)).digest('hex'),map[key]);actual.push(key);}
 }};walk(root);assert.deepEqual(actual.sort(),Object.keys(map).sort());
}
function consentClaimCaller(caller:ReviewedConsentRootCaller){
 assert.ok(caller&&Object.getPrototypeOf(caller)===ReviewedConsentRootCaller.prototype&&consentRootCallers.has(caller));
 const reviewed=consentRootCallers.get(caller)!;assert.ok(!reviewed.used&&!consentCallerActive);reviewed.used=true;consentCallerActive=true;return reviewed;
}
function consentCaptureTree(reviewed:ConsentRootInput){
 let capturedRoot:string,graph:Record<string,string>;
  const parent=dirname(reviewed.fixturePath);consentDirectory(parent,0o700);
  const raw=consentStableRead(reviewed.fixturePath,0o600,2097152);assert.equal(createHash('sha256').update(raw).digest('hex'),reviewed.fixtureSha256);
  const fixture=JSON.parse(raw.toString('utf8'));assert.equal(fixture.codeRoot,consentFixedRoot);assert.equal(fixture.signedLocalAuth,true);assert.equal(fixture.aiConsentScenario,true);
  assert.equal(consentGit(['rev-parse','HEAD']).toString().trim(),reviewed.sourceHead);
  graph=consentSourceClosure(fixture);assert.equal(consentUnionDigest(graph),reviewed.unionSha256);
  const captureFiles:Record<string,Buffer>={};
  for(const[key,digest]of Object.entries(graph)){
   const live=readFileSync(consentFixedRoot+'/'+key),committed=consentGit(['show',reviewed.sourceHead+':'+key]);
   assert.ok(live.equals(committed));assert.equal(createHash('sha256').update(committed).digest('hex'),digest);captureFiles[key]=committed;
  }
  const factoryRelativePath='tests/integration/jonghyun/isolated_ai_factory.ts';
  const factoryBytes=consentGit(['show',reviewed.sourceHead+':'+factoryRelativePath]);assert.ok(factoryBytes.equals(readFileSync(consentFixedRoot+'/'+factoryRelativePath)));
  const factorySha256=createHash('sha256').update(factoryBytes).digest('hex');captureFiles[factoryRelativePath]=factoryBytes;
  const capsulePins={...graph,[factoryRelativePath]:factorySha256};
  assert.equal(consentGit(['rev-parse','HEAD']).toString().trim(),reviewed.sourceHead);
  consentWriteBytes(parent+'/consent-root-capture-intent-private.json',Buffer.from(JSON.stringify({decisionId:reviewed.decisionId,fixtureSha256:reviewed.fixtureSha256,sourceHead:reviewed.sourceHead,unionSha256:reviewed.unionSha256,singleAttempt:true})));
  capturedRoot=parent+'/captured-consent-source';mkdirSync(capturedRoot,{mode:0o700});const directories=new Set<string>([capturedRoot]);
  for(const[key,bytes]of Object.entries(captureFiles)){
   const path=capturedRoot+'/'+key;let current=capturedRoot;
   for(const part of key.split('/').slice(0,-1)){current+='/'+part;if(!directories.has(current)){mkdirSync(current,{mode:0o700});directories.add(current);}consentDirectory(current,0o700);}
   consentWriteBytes(path,bytes);chmodSync(path,0o400);assert.ok(consentStableRead(path,0o400,1048576).equals(bytes));
  }
  for(const directory of[...directories].sort((a,b)=>b.length-a.length)){const fd=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(fd);}finally{closeSync(fd);}chmodSync(directory,0o500);}
  consentCapturedPins(capturedRoot,capsulePins);
  const capturedFixture={...fixture,codeRoot:capturedRoot};assert.deepEqual(consentSourceClosure(capturedFixture),graph);
  return {fixture,raw,capturedRoot,graph,capsulePins,factoryRelativePath,factorySha256,verify:()=>consentCapturedPins(capturedRoot,capsulePins)};
}
/** 원 CLI factory도 같은 tree로 묶는다. 이 반환 JSON을 실행 권한으로 사용하지 않는다. */
export function captureReviewedFactoryTree(caller:ReviewedConsentRootCaller){
 const reviewed=consentClaimCaller(caller);
 try{const captured=consentCaptureTree(reviewed);captured.verify();return Object.freeze({capsuleRoot:captured.capturedRoot,
  productPins:Object.freeze({...captured.graph}),capsulePins:Object.freeze({...captured.capsulePins}),factoryRelativePath:captured.factoryRelativePath,
  factorySha256:captured.factorySha256,sourceHead:reviewed.sourceHead,unionSha256:reviewed.unionSha256,verify:captured.verify});
 }catch{throw new Error('AI_CHECK_CONSENT_SOURCE_CAPTURE_FAILED');}finally{consentCallerActive=false;}
}
/** root의 검토된 in-process 조립만 호출한다. CLI의 JSON 경계는 계속 NOT_RUN이다. */
export async function runReviewedConsentCase(caller:ReviewedConsentRootCaller){
 const reviewed=consentClaimCaller(caller);let captured:ReturnType<typeof consentCaptureTree>|undefined,stage='CAPTURE';
 try{
  captured=consentCaptureTree(reviewed);const{fixture,raw,capturedRoot,graph}=captured;
  const capturedFixture={...fixture,codeRoot:capturedRoot};
  stage='READY';const ready=await reviewed.verifyReady(Object.freeze({capturedRoot,sourceHead:reviewed.sourceHead,fixtureSha256:reviewed.fixtureSha256,unionSha256:reviewed.unionSha256,
   memberId:fixture.consentAccount.userId,originalTokenSha256:createHash('sha256').update(fixture.consentAccount.token).digest('hex'),origin:fixture.origin}));assert.equal(ready,undefined);
  assert.ok(consentStableRead(reviewed.fixturePath,0o600,2097152).equals(raw));captured.verify();
  stage='RUNTIME';const result=await signedConsentCase(capturedFixture,reviewed.fixturePath);stage='FINAL_PINS';captured.verify();
  return {...result,runtimeImportSource:'PRIVATE_CAPTURED_UNION_TREE',runtimeSourceCustody:'PIN_VERIFIED_BEFORE_AND_AFTER_EXECUTION_NOT_OS_IMMUTABILITY',
   sourceHead:reviewed.sourceHead,unionSha256:reviewed.unionSha256,capturedFileCount:Object.keys(graph).length,capturedFactorySha256:captured.factorySha256};
 }catch(error){throw new Error(error instanceof Error&&/^AI_CHECK_CONSENT_[A-Z_]+$/.test(error.message)?error.message:'AI_CHECK_CONSENT_ROOT_'+stage);}
 finally{consentCallerActive=false;if(captured){try{captured.verify();}catch{throw new Error('AI_CHECK_CONSENT_CAPTURED_PIN_FAILED');}}}
}

/** 고정 AI/service-api runtime 및 type-only closure를 native parser로 검증한다. 코드 evaluate는 0회다. */
function consentSourceClosure(f:any){
 const root=resolve(f.codeRoot),base=resolve(root,'backend/supabase/functions'),expected=f.serviceProductManifest;
 assert.ok(expected&&typeof expected==='object'&&!Array.isArray(expected));
 const captured:Record<string,string>={},hashes:Record<string,string>={};
 for(const [key,digest]of Object.entries(expected)){
  assert.ok(/^backend\/supabase\/functions\/[A-Za-z0-9_./-]+\.ts$/.test(key)&&!key.split('/').includes('..'));
  const path=resolve(root,key),state=lstatSync(path);
  assert.ok(path.startsWith(base+sep)&&state.isFile()&&!state.isSymbolicLink()&&state.nlink===1);
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const before=fstatSync(fd),raw=readFileSync(fd),after=fstatSync(fd),now=lstatSync(path);
   assert.ok(raw.length<=1048576&&before.ino===state.ino&&before.dev===state.dev&&before.nlink===1);
   assert.equal(before.size,raw.length);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(after.ctimeMs,before.ctimeMs);
   assert.equal(now.ino,before.ino);assert.equal(now.dev,before.dev);
   hashes[key]=createHash('sha256').update(raw).digest('hex');assert.equal(hashes[key],digest);captured[key]=raw.toString('utf8');
  }finally{closeSync(fd);}
 }
 for(const [key,digest]of Object.entries(f.productManifest))assert.equal(hashes[key],digest,'original AI graph omitted');
 const parser=String.raw`import{SourceTextModule,runInNewContext}from'node:vm';import{stripTypeScriptTypes}from'node:module';
import{openSync,readFileSync,lstatSync,fstatSync,closeSync,constants}from'node:fs';import{createHash}from'node:crypto';import{performance}from'node:perf_hooks';
// 검토된 단일 compiler byte만 파싱 도구로 사용한다. product module evaluate/link는 0회다.
const path='/Users/minkyu/Documents/GitHub/yumidang/node_modules/typescript/lib/typescript.js';
const state=lstatSync(path);if(!state.isFile()||state.isSymbolicLink()||state.nlink!==1)throw Error();
const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);let compiler;
try{const before=fstatSync(fd);if(before.size>16777216||before.ino!==state.ino||before.dev!==state.dev||before.nlink!==1)throw Error();
 compiler=readFileSync(fd);const after=fstatSync(fd),now=lstatSync(path);
 if(compiler.length!==before.size||after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs||now.ino!==before.ino||now.dev!==before.dev||now.nlink!==1)throw Error();
 if(createHash('sha256').update(compiler).digest('hex')!=='dd17428736a07e1db1a138d8a14295ddb2699ba780ee15038acdd2c6da5373a0')throw Error();
}finally{closeSync(fd)}
const holder={exports:{}};runInNewContext(compiler.toString('utf8'),{module:holder,exports:holder.exports,require:name=>{if(name==='perf_hooks')return{performance};throw Error()}},{timeout:10000});
const ts=holder.exports;
let input='';for await(const part of process.stdin){input+=part;if(Buffer.byteLength(input)>4194304)throw Error()}
try{const output={};for(const[key,source]of Object.entries(JSON.parse(input))){
 const tree=ts.createSourceFile(key,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);if(tree.parseDiagnostics.length)throw Error();
 const specs=[];const visit=node=>{
  if(ts.isCallExpression(node)&&node.expression.kind===ts.SyntaxKind.ImportKeyword){if(node.arguments.length!==1||!ts.isStringLiteral(node.arguments[0]))throw Error();specs.push(node.arguments[0].text)}
  if(ts.isImportEqualsDeclaration(node))throw Error();
  if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier){if(!ts.isStringLiteral(node.moduleSpecifier))throw Error();specs.push(node.moduleSpecifier.text)}
  if(ts.isImportTypeNode(node)){if(!ts.isLiteralTypeNode(node.argument)||!ts.isStringLiteral(node.argument.literal))throw Error();specs.push(node.argument.literal.text)}
  ts.forEachChild(node,visit);
 };visit(tree);
 const code=stripTypeScriptTypes(source,{mode:'strip'}),module=new SourceTextModule(code,{identifier:key});specs.push(...module.dependencySpecifiers);
 output[key]=specs;
}process.stdout.write(JSON.stringify(output));}catch{process.exitCode=2}`;
 const parsed=spawnSync(process.execPath,['--experimental-vm-modules','--input-type=module','-e',parser],{
  input:JSON.stringify(captured),encoding:'utf8',timeout:20000,maxBuffer:1048576});
 assert.equal(parsed.status,0,'source graph native parser failed');assert.ok(!parsed.error);
 const dependencies=JSON.parse(parsed.stdout),pending=['backend/supabase/functions/ai-chat/index.ts','backend/supabase/functions/service-api/index.ts'],seen=new Set<string>();
 while(pending.length){const key=pending.pop()!;if(seen.has(key))continue;assert.ok(Object.hasOwn(captured,key));seen.add(key);
  for(const spec of dependencies[key]){
   assert.ok(typeof spec==='string'&&spec.startsWith('.')&&!spec.includes('\\')&&!spec.includes('?')&&!spec.includes('#'));
   const path=resolve(root,dirname(key),spec);assert.ok(path.startsWith(base+sep)&&path.endsWith('.ts'));
   const next=relative(root,path).split(sep).join('/');assert.ok(Object.hasOwn(captured,next));pending.push(next);
  }
 }
 assert.deepEqual([...seen].sort(),Object.keys(captured).sort(),'complete fixed two-entry graph required');
 return hashes;
}

/** source-selected 모형 검증용 core. 실제 CLI는 닫힘이며 live import의 동결 custody는 caller 미구현 선행조건이다. */
async function signedConsentCase(f:any,privateFixtureFile:string=file){
 const file=privateFixtureFile;
 const fixedFailures:string[]=[];const check=(value:unknown,code:string)=>{if(!value){fixedFailures.push(code);throw new Error('AI_CHECK_CONSENT_'+code);}};
 check(f.signedLocalAuth===true&&f.aiConsentScenario===true,'SCOPE');
 const account=f.consentAccount;
 check(account&&Object.keys(account).sort().join(',')==='token,userId'&&/^[a-f0-9-]{36}$/.test(account.userId)&&typeof account.token==='string','ORIGINAL_ACCOUNT');
 check(typeof f.aiLedgerId==='string'&&/^[A-Za-z0-9_.:-]{1,64}$/.test(f.aiLedgerId)&&/^synthetic-consent-[a-f0-9]{32}$/.test(f.aiQuery),'OWN_SCOPE');
 check(typeof f.positiveClientRequestId==='string'&&typeof f.deniedClientRequestId==='string'&&f.positiveClientRequestId!==f.deniedClientRequestId&&
  /^[a-f0-9-]{36}$/.test(f.positiveClientRequestId)&&/^[a-f0-9-]{36}$/.test(f.deniedClientRequestId),'CLIENT_REQUEST_SCOPE');
 const graph=consentSourceClosure(f),sourceProof=()=>{const now=consentSourceClosure(f);assert.deepEqual(now,graph);};
 const {createAiChatRuntime}=await import(pathToFileURL(f.codeRoot+'/backend/supabase/functions/ai-chat/index.ts').href);
 const {createRuntimeHandler}=await import(pathToFileURL(f.codeRoot+'/backend/supabase/functions/service-api/index.ts').href);
 const native=globalThis.fetch,hash=(value:string)=>createHash('sha256').update(value).digest('hex');
 const phases:any[]=[];let phase='positive',withdrawStarted=false,withdrawn=false,nativeExternalAttempts=0;
 const observation=()=>{let item=phases.find(p=>p.phase===phase);if(!item){item={phase,counts:{},requests:[],reservations:[],providerCalls:0};phases.push(item);}return item;};
 const save=(name:string,value:unknown)=>{const path=dirname(file)+'/'+name,bytes=Buffer.from(JSON.stringify(value));
  const fd=openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);let written;
  try{let offset=0;while(offset<bytes.length){const count=writeSync(fd,bytes,offset,bytes.length-offset);check(Number.isInteger(count)&&count>0&&count<=bytes.length-offset,'ARTIFACT_WRITE_PROGRESS');offset+=count;}
   fsyncSync(fd);written=fstatSync(fd);check(written.isFile()&&written.nlink===1&&written.uid===process.getuid!()&&(written.mode&0o777)===0o600&&written.size===bytes.length,'ARTIFACT_COMPLETE_WRITE');
  }finally{closeSync(fd);}
  for(const directory of[dirname(file),dirname(dirname(file))]){const handle=openSync(directory,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(handle);}finally{closeSync(handle);}}
  const readFd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const before=fstatSync(readFd),state=(v:any)=>[v.dev,v.ino,v.size,v.nlink,v.uid,v.mode,v.mtimeMs,v.ctimeMs];
   check(before.isFile()&&before.nlink===1&&JSON.stringify(state(written))===JSON.stringify(state(before)),'ARTIFACT_READ_IDENTITY');
   const raw=readFileSync(readFd),after=fstatSync(readFd),now=lstatSync(path);
   check(before.isFile()&&before.nlink===1&&raw.equals(bytes)&&JSON.stringify(state(written))===JSON.stringify(state(before))&&JSON.stringify(state(before))===JSON.stringify(state(after))&&JSON.stringify(state(after))===JSON.stringify(state(now)),'ARTIFACT_STABLE_EXACT_BYTES');
  }finally{closeSync(readFd);}
 };
 const env:Record<string,string>={SUPABASE_URL:f.origin,SUPABASE_ANON_KEY:f.anon,SUPABASE_SERVICE_ROLE_KEY:f.service,
  INTERNAL_WORKER_SECRET:'synthetic_ai_http_internal_secret_32_chars',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'5000',
  AI_RETENTION_DECISION_ID:'synthetic-fixture-only',AI_COST_EVIDENCE_ID:'synthetic-fixture-only',AI_PROCESSING_LEGAL_DECISION_ID:'synthetic-fixture-only',AI_MEMBER_TRANSMISSION_APPROVAL_ID:'synthetic-fixture-only',AI_BUDGET_LEDGER_ID:f.aiLedgerId,
  POTENS_ACCOUNT_ORDER:'yumi,jonghyun,minkyu,sungho',POTENS_API_KEY_YUMI:'synthetic-ai-yumi',POTENS_API_KEY_JONGHYUN:'synthetic-ai-jonghyun',POTENS_API_KEY_MINKYU:'synthetic-ai-minkyu',POTENS_API_KEY_SUNGHO:'synthetic-ai-sungho',
  POTENS_ACCOUNT_TOKEN_BUDGET:'3200000',POTENS_RESET_TIMEZONE:'Asia/Seoul',POTENS_MODEL:'claude-5-sonnet',POTENS_API_BASE_URL:'https://ai.potens.ai',POTENS_USAGE_INPUT_FIELD:'fixture_input',POTENS_USAGE_OUTPUT_FIELD:'fixture_output',
  AI_CHAT_MAX_MESSAGES:'20',AI_CHAT_MAX_MESSAGE_CHARS:'500',AI_CHAT_MAX_TOTAL_CHARS:'4000',AI_CHAT_MAX_OUTPUT_TOKENS:'800',AI_CHAT_SEARCH_PAGE_SIZE:'10',AI_CHAT_MAX_SEARCH_PAGES:'3',AI_CHAT_RECHECK_MAX_PAGES:'3',AI_CHAT_MAX_RESULT_CARDS:'5',AI_CHAT_MATCH_BATCH_SIZE:'5',AI_CHAT_MAX_MATCH_CALLS:'3',AI_CHAT_MAX_MATCH_MAX_OUTPUT_TOKENS:'600',AI_CHAT_MATCH_MAX_OUTPUT_TOKENS:'600'};
 const transport=async(input:any,init:RequestInit={})=>{
  const url=new URL(input instanceof Request?input.url:String(input)),o=observation(),headers=new Headers(init.headers);
  if(url.href==='https://ai.potens.ai/api/chat'){
   check(phase==='positive'&&o.reservations.length===1&&init.method==='POST','PROVIDER_AFTER_REAL_RESERVE');
   const reservation=o.reservations[0];check(!reservation.dispatched&&headers.get('authorization')==='Bearer synthetic-ai-'+reservation.accountId,'PROVIDER_SCOPE');
   reservation.dispatched=true;o.providerCalls++;
   return new Response(JSON.stringify({message:JSON.stringify({status:'search',filters:{target:'posts',region:'서울특별시',query:f.aiQuery,mbti:'INFP'}}),token_usage:{fixture_input:1,fixture_output:1}}),{status:200,headers:{'content-type':'application/json'}});
  }
  if(url.origin!==f.origin){nativeExternalAttempts++;throw new Error('AI_CHECK_CONSENT_EXTERNAL');}
  check(!url.search&&!url.hash&&!url.username&&!url.password,'LOCAL_URL');
  const name=url.pathname==='/auth/v1/user'?'auth':url.pathname.split('/').at(-1)!;
  const internal=['acquire_ai_chat_request','reserve_ai_chat_account_model','settle_ai_account_budget','record_ai_chat_result_available','finish_ai_chat_request'];
  check(name==='auth'||internal.includes(name)||['get_my_profile_traits','search_public_posts_v2','withdraw_my_ai_processing'].includes(name),'RPC_ALLOWLIST');
  check(url.pathname===(name==='auth'?'/auth/v1/user':'/rest/v1/rpc/'+name),'RPC_PATH');
  check(init.method===(name==='auth'?'GET':'POST'),'RPC_METHOD');
  check(headers.get('authorization')==='Bearer '+(internal.includes(name)?f.service:account.token),'ORIGINAL_JWT');
  if(phase==='withdraw')check(['auth','withdraw_my_ai_processing'].includes(name),'WITHDRAW_ONLY');
  if(phase==='denied')check(['auth','acquire_ai_chat_request'].includes(name),'DENIED_BEFORE_OTHER_RPC');
  const args=name==='auth'?{}:JSON.parse(String(init.body));
  if(name==='withdraw_my_ai_processing'){
   check(phase==='withdraw'&&withdrawStarted&&!withdrawn&&JSON.stringify(args)==='{"p_kind":"exploration"}','PUBLIC_WITHDRAW_SCOPE');
   check(!o.counts.withdraw_my_ai_processing,'WITHDRAW_ONE_ATTEMPT');
  }
  if(internal.includes(name)&&name!=='settle_ai_account_budget')check(args.p_user_id===account.userId,'ACTUAL_MEMBER_SCOPE');
  if(name==='acquire_ai_chat_request')check(args.p_client_request_id===(phase==='positive'?f.positiveClientRequestId:f.deniedClientRequestId)&&args.p_contract_version==='2026-10-05'&&args.p_output_retry_of===null,'REQUEST_KEY');
  if(name==='reserve_ai_chat_account_model')check(phase==='positive'&&args.p_request_id===o.requests[0]?.requestId&&hash(args.p_lease_token)===o.requests[0]?.leaseSha256&&args.p_ledger_id===f.aiLedgerId&&args.p_task==='intent','RESERVE_ORIGINAL_SCOPE');
  if(name==='settle_ai_account_budget')check(o.reservations[0]?.dispatched&&args.p_reservation_id===o.reservations[0].reservationId&&args.p_account_id===o.reservations[0].accountId&&args.p_account_day===o.reservations[0].accountDay&&args.p_outcome==='usage_reported'&&args.p_input_tokens===1&&args.p_output_tokens===1,'SETTLE_ORIGINAL_SCOPE');
  if(['record_ai_chat_result_available','finish_ai_chat_request'].includes(name))check(args.p_request_id===o.requests[0]?.requestId&&hash(args.p_lease_token)===o.requests[0]?.leaseSha256,'FINISH_ORIGINAL_SCOPE');
  o.counts[name]=(o.counts[name]??0)+1;
  const response=await native(input,{...init,redirect:'error'});check(response.status===200,'ACTUAL_UPSTREAM_STATUS');const result=await response.clone().json();
  if(name==='auth')check(result.id===account.userId&&result.role==='authenticated'&&result.is_anonymous!==true,'ACTUAL_MEMBER_AUTH');
  if(name==='acquire_ai_chat_request')o.requests.push({requestId:args.p_request_id,clientRequestId:args.p_client_request_id,status:result.status,...(result.status==='acquired'?{leaseSha256:hash(result.leaseToken)}:{})});
  if(name==='reserve_ai_chat_account_model'){check(result.status==='reserved','REAL_RESERVATION');o.reservations.push({reservationId:result.reservationId,accountId:result.accountId,accountDay:result.accountDay,units:args.p_units,requestId:args.p_request_id,dispatched:false,settled:false});}
  if(name==='settle_ai_account_budget'){check(result.settled===true&&result.pending===false,'REAL_SETTLEMENT');o.reservations[0].settled=true;}
  if(name==='search_public_posts_v2')check(Array.isArray(result.items)&&result.items.length===0&&result.nextCursor===null,'NORMAL_EMPTY_SEARCH');
  if(name==='withdraw_my_ai_processing'){check(Object.keys(result).length===1&&result.withdrawn===true,'PUBLIC_WITHDRAW_RESULT');withdrawn=true;}
  return response;
 };
 const outputLimit={decisionId:'synthetic-wire-only',apply:(body:any,limit:number)=>({...body,synthetic_max_output_tokens:limit})};
 const ai=createAiChatRuntime((key:string)=>env[key],transport,{privacy:{decisionId:'synthetic-local-only',check:async()=>true},outputLimit});
 const aiRequest=(clientRequestId:string)=>new Request(f.origin+'/functions/v1/ai-chat',{method:'POST',headers:{authorization:'Bearer '+account.token,'content-type':'application/json'},
  body:JSON.stringify({clientRequestId,messages:[{role:'user',content:'합성 AI 동의 철회 검사'}],currentFilters:{target:'posts',region:'서울특별시',query:f.aiQuery,mbti:'INFP'}})});
 globalThis.fetch=transport;
 try{
  const positive=await ai(aiRequest(f.positiveClientRequestId)),positiveBody=await positive.json(),p=observation();
  check(positive.status===200&&positiveBody.data?.status==='no_results'&&positiveBody.data.requestId===positive.headers.get('x-request-id'),'READY_POSITIVE_CONTROL');
  check(p.requests.length===1&&p.requests[0].status==='acquired'&&p.providerCalls===1&&p.reservations.length===1&&p.reservations[0].settled&&
   p.counts.auth===1&&p.counts.acquire_ai_chat_request===1&&p.counts.reserve_ai_chat_account_model===1&&p.counts.settle_ai_account_budget===1&&p.counts.record_ai_chat_result_available===1&&p.counts.finish_ai_chat_request===1,'READY_POSITIVE_REAL_PORTS');
  check(positiveBody.data.requestId===p.requests[0].requestId,'NORMAL_REQUEST_RESPONSE_BINDING');
  phase='withdraw';sourceProof();save('consent-withdraw-intent-private.json',{singleAttempt:true,memberId:account.userId,originalTokenSha256:hash(account.token),kind:'exploration',positiveRequestId:p.requests[0].requestId});withdrawStarted=true;
  const service=createRuntimeHandler((key:string)=>env[key]);
  const response=await service(new Request(f.origin+'/functions/v1/service-api/me/ai-processing/withdraw',{method:'POST',headers:{authorization:'Bearer '+account.token,'content-type':'application/json'},body:JSON.stringify({kind:'exploration'})}));
  const body=await response.json(),w=observation();check(response.status===200&&body.data?.withdrawn===true&&withdrawn,'PUBLIC_SERVICE_ROUTE');
  check(w.counts.auth===1&&w.counts.withdraw_my_ai_processing===1&&Object.keys(w.counts).length===2,'PUBLIC_SERVICE_AUTH_AND_ONE_RPC');
  phase='denied';const denied=await ai(aiRequest(f.deniedClientRequestId)),deniedBody=await denied.json(),d=observation();
  check(denied.status===200&&deniedBody.data?.status==='unavailable'&&deniedBody.data.recovery?.reason==='consent'&&deniedBody.data.recovery.retryAllowed===false,'CONSENT_NOT_FALLBACK_UNAVAILABLE');
  check(d.counts.auth===1&&d.counts.acquire_ai_chat_request===1&&Object.keys(d.counts).length===2&&d.providerCalls===0&&d.reservations.length===0&&d.requests.length===1&&d.requests[0].status==='consent_revoked','CONSENT_WITHOUT_RESERVATION');
  check(deniedBody.data.requestId===d.requests[0].requestId&&deniedBody.data.requestId===denied.headers.get('x-request-id'),'DENIED_REQUEST_BINDING');
  sourceProof();check(nativeExternalAttempts===0,'EXTERNAL_ZERO');check(fixedFailures.length===0,'CAUGHT_CONTROL_FAILURE');
  return {status:'PASS',case:'signed-public-consent-withdrawal',phases,originalTokenSha256:hash(account.token),nativeExternalAttempts,
   actualFactoryRoute:'POST /functions/v1/service-api/me/ai-processing/withdraw',publicMutationCalls:1,providerScope:'EXPLICIT_SYNTHETIC_IN_MEMORY_ADAPTER',
   serviceMemberRetirement:'NOT_RUN',actualDatabaseBaselinePreservation:'CALLER_REQUIRED_NOT_VERIFIED_BY_FACTORY',actualProviderLegalBillingNaverRealMembers:'NOT_RUN'};
 }finally{
  globalThis.fetch=native;
  save('consent-factory-evidence-private.json',{phases,fixedFailures,withdrawStarted,withdrawn,nativeExternalAttempts,originalTokenSha256:hash(account.token),rawContentLogged:false});
 }
}

async function aiMidnightHttpCase(f:any){
 const check=(value:unknown,code:string)=>{if(!value)throw new Error('AI_CHECK_'+code);};
 check(f.scenario==='ai-chat'&&f.aiMidnightScenario===true&&f.accounts.length===3,'MIDNIGHT_SCOPE');
 const {createAiChatRuntime}=await import(pathToFileURL(f.codeRoot+'/backend/supabase/functions/ai-chat/index.ts').href);
 const native=globalThis.fetch,hash=(v:string)=>createHash('sha256').update(v).digest('hex');
 const observations:any[]=[];let nativeExternalAttempts=0;
 const localOnly=async(url:any,init:RequestInit={})=>{
  const u=new URL(String(url));if(u.origin!==f.origin){nativeExternalAttempts++;throw new Error('AI_EXTERNAL_NATIVE_FORBIDDEN');}
  check(u.pathname==='/auth/v1/user'||u.pathname.startsWith('/rest/v1/rpc/'),'MIDNIGHT_LOCAL_PATH');
  check(init.method!=='DELETE','MIDNIGHT_DELETE_ZERO');return native(url,init);
 };
 const env:Record<string,string>={SUPABASE_URL:f.origin,SUPABASE_ANON_KEY:f.anon,SUPABASE_SERVICE_ROLE_KEY:f.service,
  INTERNAL_WORKER_SECRET:'synthetic_ai_http_internal_secret_32_chars',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'5000',
  AI_RETENTION_DECISION_ID:'synthetic-fixture-only',AI_COST_EVIDENCE_ID:'synthetic-fixture-only',AI_PROCESSING_LEGAL_DECISION_ID:'synthetic-fixture-only',AI_MEMBER_TRANSMISSION_APPROVAL_ID:'synthetic-fixture-only',AI_BUDGET_LEDGER_ID:f.aiLedgerId,
  POTENS_ACCOUNT_ORDER:'yumi,jonghyun,minkyu,sungho',POTENS_API_KEY_YUMI:'synthetic-ai-yumi',POTENS_API_KEY_JONGHYUN:'synthetic-ai-jonghyun',POTENS_API_KEY_MINKYU:'synthetic-ai-minkyu',POTENS_API_KEY_SUNGHO:'synthetic-ai-sungho',
  POTENS_ACCOUNT_TOKEN_BUDGET:'3200000',POTENS_RESET_TIMEZONE:'Asia/Seoul',POTENS_MODEL:'claude-5-sonnet',POTENS_API_BASE_URL:'https://ai.potens.ai',POTENS_USAGE_INPUT_FIELD:'fixture_input',POTENS_USAGE_OUTPUT_FIELD:'fixture_output',
  AI_CHAT_MAX_MESSAGES:'20',AI_CHAT_MAX_MESSAGE_CHARS:'500',AI_CHAT_MAX_TOTAL_CHARS:'4000',AI_CHAT_MAX_OUTPUT_TOKENS:'800',AI_CHAT_SEARCH_PAGE_SIZE:'10',AI_CHAT_MAX_SEARCH_PAGES:'3',AI_CHAT_RECHECK_MAX_PAGES:'3',AI_CHAT_MAX_RESULT_CARDS:'5',AI_CHAT_MATCH_BATCH_SIZE:'5',AI_CHAT_MAX_MATCH_CALLS:'3',AI_CHAT_MAX_MATCH_MAX_OUTPUT_TOKENS:'600',AI_CHAT_MATCH_MAX_OUTPUT_TOKENS:'600'};

 const invoke=async(account:number,label:string,hold=false)=>{
  let holdFailed=false;
  const token=f.accounts[account].token,uid=f.accounts[account].userId;
  const o:any={case:label,account,requests:[],reservations:[],counts:{},providerInterceptions:0};observations.push(o);
  const transport=async(url:any,init:RequestInit={})=>{
   if(String(url)==='https://ai.potens.ai/api/chat'){
    check(init.method==='POST'&&o.reservations.length===1,'MIDNIGHT_PROVIDER_AFTER_RESERVE');
    const reservation=o.reservations[0],wire=JSON.parse(String(init.body));
    check(!reservation.dispatched&&new Headers(init.headers).get('authorization')==='Bearer synthetic-ai-'+reservation.accountId,'MIDNIGHT_PROVIDER_IDENTITY');
    check(wire.model==='claude-5-sonnet'&&wire.synthetic_max_output_tokens===800&&typeof wire.prompt==='string','MIDNIGHT_PROVIDER_WIRE');
    check(!wire.prompt.includes('AI_PRIVATE_MEETING_CANARY'),'MIDNIGHT_PROVIDER_PRIVACY');
    reservation.dispatched=true;o.providerInterceptions++;
    if(hold){
     try{
     const {openSync,writeFileSync,fsyncSync,closeSync,existsSync}=await import('node:fs');
     const emit=(name:string,value:unknown)=>{const fd=openSync(f.midnightDir+'/'+name,'wx',0o600);try{writeFileSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}};
     emit('midnight-provider-marker.json',{requestId:o.requests[0].requestId,reservationId:reservation.reservationId,accountId:reservation.accountId,accountDay:reservation.accountDay,units:reservation.units,leaseSha256:o.requests[0].leaseSha256});
     emit('midnight-provider-ready.json',{ready:true});
     const deadline=performance.now()+2800;
     while(!existsSync(f.midnightDir+'/midnight-provider-release.json')){
      check(!init.signal?.aborted&&performance.now()<deadline,'MIDNIGHT_HOLD_ABORT_OR_TIMEOUT');
      await new Promise(r=>setTimeout(r,20));
     }
     const path=f.midnightDir+'/midnight-provider-release.json',entry=lstatSync(path);
     check(entry.isFile()&&!entry.isSymbolicLink()&&entry.nlink===1&&entry.uid===process.getuid!()&&(entry.mode&0o777)===0o600&&!init.signal?.aborted&&performance.now()<deadline,'MIDNIGHT_RELEASE_PRIVATE_AND_ON_TIME');
     const release=JSON.parse(readFileSync(path,'utf8'));
     check(release.requestId===o.requests[0].requestId&&release.reservationId===reservation.reservationId&&release.beforeDay===f.originalDay&&release.afterDay===f.nextDay&&release.beforeEpoch<f.midnightEpoch&&release.afterEpoch>=f.midnightEpoch&&release.afterEpoch<f.midnightEpoch+2,'MIDNIGHT_RELEASE_SQL_CHECKPOINT');
     }catch(error){holdFailed=true;throw error;}
    }
    return new Response(JSON.stringify({message:JSON.stringify({status:'search',filters:{target:'posts',region:'서울특별시',query:f.aiQuery,mbti:'INFP'}}),token_usage:{fixture_input:1,fixture_output:1}}),{status:200,headers:{'content-type':'application/json'}});
   }
   const u=new URL(String(url)),headers=new Headers(init.headers);check(u.origin===f.origin,'MIDNIGHT_RPC_ORIGIN');
   const name=u.pathname==='/auth/v1/user'?'auth':u.pathname.split('/').at(-1)!;
   const internal=['acquire_ai_chat_request','reserve_ai_chat_account_model','settle_ai_account_budget','record_ai_chat_result_available','finish_ai_chat_request'];
   check(name==='auth'||internal.includes(name)||['get_my_profile_traits','search_public_posts_v2','get_post_author_traits'].includes(name),'MIDNIGHT_RPC_ALLOWLIST');
   check(init.method===(name==='auth'?'GET':'POST'),'MIDNIGHT_RPC_METHOD');
   check(headers.get('authorization')==='Bearer '+(internal.includes(name)?f.service:token),'MIDNIGHT_RPC_JWT');
   const args=name==='auth'?{}:JSON.parse(String(init.body));
   if(internal.includes(name)&&name!=='settle_ai_account_budget')check(args.p_user_id===uid,'MIDNIGHT_MEMBER_SCOPE');
   const request=o.requests[0];
   if(name==='reserve_ai_chat_account_model')check(request?.acquireStatus==='acquired'&&request.requestId===args.p_request_id&&request.leaseSha256===hash(args.p_lease_token)&&args.p_ledger_id===f.aiLedgerId&&args.p_task==='intent'&&args.p_provider_id==='potens'&&args.p_contract_version==='2026-10-05'&&Number.isSafeInteger(args.p_units)&&args.p_units>0,'MIDNIGHT_RESERVE_SCOPE');
   if(name==='settle_ai_account_budget'){
    const r=o.reservations[0];check(r?.dispatched&&!r.settled&&r.reservationId===args.p_reservation_id&&r.accountId===args.p_account_id&&r.accountDay===args.p_account_day,'MIDNIGHT_SETTLE_SCOPE');
    check(args.p_outcome===(holdFailed?'usage_unknown':'usage_reported')&&(holdFailed?args.p_input_tokens===null&&args.p_output_tokens===null:args.p_input_tokens===1&&args.p_output_tokens===1),'MIDNIGHT_SETTLE_USAGE');
   }
   if(['record_ai_chat_result_available','finish_ai_chat_request'].includes(name))check(request?.requestId===args.p_request_id&&request.leaseSha256===hash(args.p_lease_token),'MIDNIGHT_FINISH_SCOPE');
   o.counts[name]=(o.counts[name]??0)+1;const response=await localOnly(url,init);
   if(name!=='auth'){
    check(response.status===200,'MIDNIGHT_ACTUAL_RPC_HTTP');const value=await response.clone().json();
    if(name==='acquire_ai_chat_request')o.requests.push({requestId:args.p_request_id,acquireStatus:value.status,...(value.status==='acquired'?{leaseSha256:hash(value.leaseToken)}:{})});
    if(name==='reserve_ai_chat_account_model'){check(value.status==='reserved'&&value.accountDay===(f.midnightPhase==='held'?f.originalDay:f.nextDay),'MIDNIGHT_RESERVE_SUCCEEDED');o.reservations.push({reservationId:value.reservationId,accountId:value.accountId,accountDay:value.accountDay,requestId:args.p_request_id,units:args.p_units,dispatched:false,settled:false});}
    if(name==='settle_ai_account_budget')o.reservations[0].settled=true;
    if(name==='search_public_posts_v2')check(value.items.length===0&&value.nextCursor===null,'MIDNIGHT_REAL_EMPTY_SEARCH');
   }
   return response;
  };
  const handler=createAiChatRuntime((key:string)=>env[key],transport,{privacy:{decisionId:'synthetic-local-only',check:async()=>true},outputLimit:{decisionId:'synthetic-wire-only',apply:(body:any,limit:number)=>({...body,synthetic_max_output_tokens:limit})}});
  const response=await handler(new Request(f.origin+'/functions/v1/ai-chat',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({clientRequestId:randomUUID().replace(/[0-9]/g,d=>String.fromCharCode(103+Number(d))),messages:[{role:'user',content:'AI_DIALOGUE_CANARY 합성 한도 탐색'}],currentFilters:{target:'posts',region:'서울특별시',query:f.aiQuery,mbti:'INFP'}})}));
  const data=(await response.json()).data;check(response.status===200&&data.requestId===response.headers.get('x-request-id')&&data.cards.length===0&&data.explanations.length===0,'MIDNIGHT_HTTP_RECEIPT');
  o.result={httpStatus:response.status,status:data.status,requestId:data.requestId,...(data.recovery?{recoveryReason:data.recovery.reason}:{}),outputSha256:hash(JSON.stringify(data))};
  check(data.status==='no_results'&&o.requests[0]?.acquireStatus==='acquired'&&o.providerInterceptions===1&&o.reservations.length===1&&o.reservations[0].settled&&o.counts.finish_ai_chat_request===1&&o.counts.record_ai_chat_result_available===1,'MIDNIGHT_ACTUAL_LIFECYCLE');
  return o;
 };
 globalThis.fetch=localOnly;
 try{
  check(['held','new-day'].includes(f.midnightPhase)&&f.midnightDir===dirname(file),'MIDNIGHT_FIXED_PRIVATE_ROOT');
  check(/^\d{4}-\d{2}-\d{2}$/.test(f.originalDay)&&/^\d{4}-\d{2}-\d{2}$/.test(f.nextDay)&&f.originalDay!==f.nextDay&&Number.isFinite(f.midnightEpoch),'MIDNIGHT_TARGET');
  if(f.midnightPhase==='held')await invoke(0,'held-across-midnight',true);
  else{await invoke(1,'new-day-after-twenty');await invoke(2,'new-day-after-unknown');}
  check(nativeExternalAttempts===0&&observations.length===(f.midnightPhase==='held'?1:2),'MIDNIGHT_EXTERNAL_ZERO_AND_COUNT');
  return {status:'PASS',case:'ai-midnight-'+f.midnightPhase,observations,nativeExternalAttempts,modelScope:'EXPLICIT_SYNTHETIC_IN_MEMORY_ADAPTER',syntheticUsageOnly:true,realProviderQualityAccountCostResetSharedUseLegalMemberLogin:'NOT_RUN',rawPromptModelResponseLogged:false};
 }finally{globalThis.fetch=native;}
}


async function aiLimitsHttpCase(f:any){
 const check=(value:unknown,code:string)=>{if(!value)throw new Error('AI_CHECK_'+code);};
 check(f.scenario==='ai-chat'&&f.aiLimitsScenario===true&&f.accounts.length===3,'LIMITS_SCOPE');
 const {createAiChatRuntime}=await import(pathToFileURL(f.codeRoot+'/backend/supabase/functions/ai-chat/index.ts').href);
 const native=globalThis.fetch,hash=(v:string)=>createHash('sha256').update(v).digest('hex');
 const observations:any[]=[],units:any[]=[];let nativeExternalAttempts=0;
 const localOnly=async(url:any,init:RequestInit={})=>{
  const u=new URL(String(url));if(u.origin!==f.origin){nativeExternalAttempts++;throw new Error('AI_EXTERNAL_NATIVE_FORBIDDEN');}
  check(u.pathname==='/auth/v1/user'||u.pathname.startsWith('/rest/v1/rpc/'),'LIMITS_LOCAL_PATH');
  check(init.method!=='DELETE','LIMITS_DELETE_ZERO');return native(url,init);
 };
 const barrier=()=>{
  let arrived!:()=>void,release!:()=>void;let held=true;
  const ready=new Promise<void>(r=>{arrived=r;}),released=new Promise<void>(r=>{release=()=>{held=false;r();};});
  return {ready,released,arrived,release,isHeld:()=>held};
 };
 const ready=async(b:ReturnType<typeof barrier>)=>{
  let timer:any;try{await Promise.race([b.ready,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('AI_CHECK_LIMITS_BARRIER_TIMEOUT')),1500);})]);}finally{clearTimeout(timer);}
 };
 const env:Record<string,string>={SUPABASE_URL:f.origin,SUPABASE_ANON_KEY:f.anon,SUPABASE_SERVICE_ROLE_KEY:f.service,
  INTERNAL_WORKER_SECRET:'synthetic_ai_http_internal_secret_32_chars',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'5000',
  AI_RETENTION_DECISION_ID:'synthetic-fixture-only',AI_COST_EVIDENCE_ID:'synthetic-fixture-only',AI_PROCESSING_LEGAL_DECISION_ID:'synthetic-fixture-only',AI_MEMBER_TRANSMISSION_APPROVAL_ID:'synthetic-fixture-only',AI_BUDGET_LEDGER_ID:f.aiLedgerId,
  POTENS_ACCOUNT_ORDER:'yumi,jonghyun,minkyu,sungho',POTENS_API_KEY_YUMI:'synthetic-ai-yumi',POTENS_API_KEY_JONGHYUN:'synthetic-ai-jonghyun',POTENS_API_KEY_MINKYU:'synthetic-ai-minkyu',POTENS_API_KEY_SUNGHO:'synthetic-ai-sungho',
  POTENS_ACCOUNT_TOKEN_BUDGET:'3200000',POTENS_RESET_TIMEZONE:'Asia/Seoul',POTENS_MODEL:'claude-5-sonnet',POTENS_API_BASE_URL:'https://ai.potens.ai',POTENS_USAGE_INPUT_FIELD:'fixture_input',POTENS_USAGE_OUTPUT_FIELD:'fixture_output',
  AI_CHAT_MAX_MESSAGES:'20',AI_CHAT_MAX_MESSAGE_CHARS:'500',AI_CHAT_MAX_TOTAL_CHARS:'4000',AI_CHAT_MAX_OUTPUT_TOKENS:'800',AI_CHAT_SEARCH_PAGE_SIZE:'10',AI_CHAT_MAX_SEARCH_PAGES:'3',AI_CHAT_RECHECK_MAX_PAGES:'3',AI_CHAT_MAX_RESULT_CARDS:'5',AI_CHAT_MATCH_BATCH_SIZE:'5',AI_CHAT_MAX_MATCH_CALLS:'3',AI_CHAT_MAX_MATCH_MAX_OUTPUT_TOKENS:'600',AI_CHAT_MATCH_MAX_OUTPUT_TOKENS:'600'};

 const invoke=async(account:number,label:string,expectedReason?:string,hold?:ReturnType<typeof barrier>,loss=false)=>{
  const token=f.accounts[account].token,uid=f.accounts[account].userId;
  const o:any={case:label,account,requests:[],reservations:[],counts:{},providerInterceptions:0};observations.push(o);
  const transport=async(url:any,init:RequestInit={})=>{
   if(String(url)==='https://ai.potens.ai/api/chat'){
    check(init.method==='POST'&&o.reservations.length===1,'LIMITS_PROVIDER_AFTER_RESERVE');
    const reservation=o.reservations[0],wire=JSON.parse(String(init.body));
    check(!reservation.dispatched&&new Headers(init.headers).get('authorization')==='Bearer synthetic-ai-'+reservation.accountId,'LIMITS_PROVIDER_IDENTITY');
    check(wire.model==='claude-5-sonnet'&&wire.synthetic_max_output_tokens===800&&typeof wire.prompt==='string','LIMITS_PROVIDER_WIRE');
    check(!wire.prompt.includes('AI_PRIVATE_MEETING_CANARY'),'LIMITS_PROVIDER_PRIVACY');
    reservation.dispatched=true;o.providerInterceptions++;
    if(hold){hold.arrived();await hold.released;}
    if(loss)throw new Error('AI_SYNTHETIC_RESPONSE_LOSS');
    return new Response(JSON.stringify({message:JSON.stringify({status:'search',filters:{target:'posts',region:'서울특별시',query:f.aiQuery,mbti:'INFP'}}),token_usage:{fixture_input:1,fixture_output:1}}),{status:200,headers:{'content-type':'application/json'}});
   }
   const u=new URL(String(url)),headers=new Headers(init.headers);check(u.origin===f.origin,'LIMITS_RPC_ORIGIN');
   const name=u.pathname==='/auth/v1/user'?'auth':u.pathname.split('/').at(-1)!;
   const internal=['acquire_ai_chat_request','reserve_ai_chat_account_model','settle_ai_account_budget','record_ai_chat_result_available','finish_ai_chat_request'];
   check(name==='auth'||internal.includes(name)||['get_my_profile_traits','search_public_posts_v2','get_post_author_traits'].includes(name),'LIMITS_RPC_ALLOWLIST');
   check(init.method===(name==='auth'?'GET':'POST'),'LIMITS_RPC_METHOD');
   check(headers.get('authorization')==='Bearer '+(internal.includes(name)?f.service:token),'LIMITS_RPC_JWT');
   const args=name==='auth'?{}:JSON.parse(String(init.body));
   if(internal.includes(name)&&name!=='settle_ai_account_budget')check(args.p_user_id===uid,'LIMITS_MEMBER_SCOPE');
   const request=o.requests[0];
   if(name==='reserve_ai_chat_account_model')check(request?.acquireStatus==='acquired'&&request.requestId===args.p_request_id&&request.leaseSha256===hash(args.p_lease_token)&&args.p_ledger_id===f.aiLedgerId&&args.p_task==='intent'&&args.p_provider_id==='potens'&&args.p_contract_version==='2026-10-05'&&Number.isSafeInteger(args.p_units)&&args.p_units>0,'LIMITS_RESERVE_SCOPE');
   if(name==='settle_ai_account_budget'){
    const r=o.reservations[0];check(r?.dispatched&&!r.settled&&r.reservationId===args.p_reservation_id&&r.accountId===args.p_account_id&&r.accountDay===args.p_account_day,'LIMITS_SETTLE_SCOPE');
    check(args.p_outcome===(loss?'usage_unknown':'usage_reported')&&(loss?args.p_input_tokens===null&&args.p_output_tokens===null:args.p_input_tokens===1&&args.p_output_tokens===1),'LIMITS_SETTLE_USAGE');
   }
   if(['record_ai_chat_result_available','finish_ai_chat_request'].includes(name))check(request?.requestId===args.p_request_id&&request.leaseSha256===hash(args.p_lease_token),'LIMITS_FINISH_SCOPE');
   o.counts[name]=(o.counts[name]??0)+1;const response=await localOnly(url,init);
   if(name!=='auth'){
    check(response.status===200,'LIMITS_ACTUAL_RPC_HTTP');const value=await response.clone().json();
    if(name==='acquire_ai_chat_request')o.requests.push({requestId:args.p_request_id,acquireStatus:value.status,...(value.status==='acquired'?{leaseSha256:hash(value.leaseToken)}:{})});
    if(name==='reserve_ai_chat_account_model'){check(value.status==='reserved','LIMITS_RESERVE_SUCCEEDED');o.reservations.push({reservationId:value.reservationId,accountId:value.accountId,accountDay:value.accountDay,requestId:args.p_request_id,units:args.p_units,dispatched:false,settled:false});}
    if(name==='settle_ai_account_budget')o.reservations[0].settled=true;
    if(name==='search_public_posts_v2')check(value.items.length===0&&value.nextCursor===null,'LIMITS_REAL_EMPTY_SEARCH');
   }
   return response;
  };
  const handler=createAiChatRuntime((key:string)=>env[key],transport,{privacy:{decisionId:'synthetic-local-only',check:async()=>true},outputLimit:{decisionId:'synthetic-wire-only',apply:(body:any,limit:number)=>({...body,synthetic_max_output_tokens:limit})}});
  const response=await handler(new Request(f.origin+'/functions/v1/ai-chat',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({clientRequestId:randomUUID().replace(/[0-9]/g,d=>String.fromCharCode(103+Number(d))),messages:[{role:'user',content:'AI_DIALOGUE_CANARY 합성 한도 탐색'}],currentFilters:{target:'posts',region:'서울특별시',query:f.aiQuery,mbti:'INFP'}})}));
  const data=(await response.json()).data;check(response.status===200&&data.requestId===response.headers.get('x-request-id')&&data.cards.length===0&&data.explanations.length===0,'LIMITS_HTTP_RECEIPT');
  o.result={httpStatus:response.status,status:data.status,requestId:data.requestId,...(data.recovery?{recoveryReason:data.recovery.reason}:{}),outputSha256:hash(JSON.stringify(data))};
  if(expectedReason){check(data.status==='unavailable'&&data.recovery?.reason===expectedReason&&o.requests[0]?.acquireStatus===expectedReason&&!o.reservations.length&&!o.providerInterceptions&&!o.counts.finish_ai_chat_request&&!o.counts.record_ai_chat_result_available,'LIMITS_DENIAL_NO_EFFECT');}
  else{check(data.status===(loss?'unavailable':'no_results')&&o.requests[0]?.acquireStatus==='acquired'&&o.providerInterceptions===1&&o.reservations.length===1&&o.reservations[0].settled&&o.counts.finish_ai_chat_request===1&&(o.counts.record_ai_chat_result_available??0)===(loss?0:1),'LIMITS_ACTUAL_LIFECYCLE');}
  return o;
 };
 globalThis.fetch=localOnly;const holds:ReturnType<typeof barrier>[]=[];
 try{
  if(f.aiLimitsRecovery===true){
   await invoke(2,'after-unknown');check(nativeExternalAttempts===0,'LIMITS_RECOVERY_EXTERNAL_ZERO');
   return {status:'PASS',case:'ai-limits-recovery',observations,nativeExternalAttempts};
  }
  for(let i=0;i<20;i++)await invoke(1,'accepted-'+String(i+1));
  await invoke(1,'denied-21','daily_limit');units.push({case:'twenty_then_twenty_one',accepted:20,denied:1});
  const same=barrier();holds.push(same);const first=invoke(0,'overlap-first',undefined,same);
  try{await ready(same);await invoke(0,'overlap-denied','concurrent');check(same.isHeld(),'LIMITS_OVERLAP_STILL_RESERVED');}finally{same.release();await first;}
  await invoke(0,'after-overlap');units.push({case:'same_member_overlap',accepted:2,denied:1,barrierAfterRealReservation:true});
  const left=barrier(),right=barrier();holds.push(left,right);
  const a=invoke(0,'cross-left',undefined,left),b=invoke(2,'cross-right',undefined,right);
  try{await Promise.all([ready(left),ready(right)]);check(left.isHeld()&&right.isHeld(),'LIMITS_CROSS_MEMBER_OVERLAP');}finally{left.release();right.release();await Promise.all([a,b]);}
  units.push({case:'cross_member_reservations',accepted:2,simultaneousReserved:true});
  await invoke(2,'unknown-provider-loss',undefined,undefined,true);
  units.push({case:'unknown_preservation',accepted:1,unknown:1,subsequentDbHashCheckRequired:true});
  check(nativeExternalAttempts===0&&observations.length===27,'LIMITS_EXTERNAL_ZERO_AND_COUNT');
  return {status:'PASS',case:'ai-limits',observations,units,nativeExternalAttempts,modelScope:'EXPLICIT_SYNTHETIC_IN_MEMORY_ADAPTER',syntheticUsageOnly:true,actualWallClockMidnight:'NOT_RUN',accountAndGlobalCapExhaustion:'NOT_IMPLEMENTED',realProviderQualityAccountCostResetSharedUseLegalMemberLogin:'NOT_RUN',rawPromptModelResponseLogged:false};
 }finally{for(const held of holds)held.release();globalThis.fetch=native;}
}

async function aiCapsHttpCase(f:any){
 const check=(value:unknown,code:string)=>{if(!value)throw new Error('AI_CHECK_'+code);};
 check(f.scenario==='ai-chat'&&f.aiCapsScenario===true&&f.accounts.length===3,'CAPS_SCOPE');
 const {createAiChatRuntime}=await import(pathToFileURL(f.codeRoot+'/backend/supabase/functions/ai-chat/index.ts').href);
 const native=globalThis.fetch,hash=(v:string)=>createHash('sha256').update(v).digest('hex');
 const observations:any[]=[];const accountIds=['yumi','jonghyun','minkyu','sungho'];let nativeExternalAttempts=0;
 const localOnly=async(url:any,init:RequestInit={})=>{
  const u=new URL(String(url));if(u.origin!==f.origin){nativeExternalAttempts++;throw new Error('AI_EXTERNAL_NATIVE_FORBIDDEN');}
  check(u.pathname==='/auth/v1/user'||u.pathname.startsWith('/rest/v1/rpc/'),'CAPS_LOCAL_PATH');
  check(init.method!=='DELETE','CAPS_DELETE_ZERO');return native(url,init);
 };
 const env:Record<string,string>={SUPABASE_URL:f.origin,SUPABASE_ANON_KEY:f.anon,SUPABASE_SERVICE_ROLE_KEY:f.service,
  INTERNAL_WORKER_SECRET:'synthetic_ai_http_internal_secret_32_chars',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'5000',
  AI_RETENTION_DECISION_ID:'synthetic-fixture-only',AI_COST_EVIDENCE_ID:'synthetic-fixture-only',AI_PROCESSING_LEGAL_DECISION_ID:'synthetic-fixture-only',AI_MEMBER_TRANSMISSION_APPROVAL_ID:'synthetic-fixture-only',AI_BUDGET_LEDGER_ID:f.aiLedgerId,
  POTENS_ACCOUNT_ORDER:'yumi,jonghyun,minkyu,sungho',POTENS_API_KEY_YUMI:'synthetic-ai-yumi',POTENS_API_KEY_JONGHYUN:'synthetic-ai-jonghyun',POTENS_API_KEY_MINKYU:'synthetic-ai-minkyu',POTENS_API_KEY_SUNGHO:'synthetic-ai-sungho',
  POTENS_ACCOUNT_TOKEN_BUDGET:'3200000',POTENS_RESET_TIMEZONE:'Asia/Seoul',POTENS_MODEL:'claude-5-sonnet',POTENS_API_BASE_URL:'https://ai.potens.ai',POTENS_USAGE_INPUT_FIELD:'fixture_input',POTENS_USAGE_OUTPUT_FIELD:'fixture_output',
  AI_CHAT_MAX_MESSAGES:'20',AI_CHAT_MAX_MESSAGE_CHARS:'500',AI_CHAT_MAX_TOTAL_CHARS:'4000',AI_CHAT_MAX_OUTPUT_TOKENS:'800',AI_CHAT_SEARCH_PAGE_SIZE:'10',AI_CHAT_MAX_SEARCH_PAGES:'3',AI_CHAT_RECHECK_MAX_PAGES:'3',AI_CHAT_MAX_RESULT_CARDS:'5',AI_CHAT_MATCH_BATCH_SIZE:'5',AI_CHAT_MAX_MATCH_CALLS:'3',AI_CHAT_MAX_MATCH_MAX_OUTPUT_TOKENS:'600',AI_CHAT_MATCH_MAX_OUTPUT_TOKENS:'600'};

 const invoke=async(label:string,target:string|null,charge:number,loss=false,denied=false)=>{
  const account=0;check(Number.isSafeInteger(charge)&&charge>=0&&charge<=3200000,'CAPS_SYNTHETIC_USAGE_BOUND');
  const token=f.accounts[account].token,uid=f.accounts[account].userId;
  const o:any={case:label,account,requests:[],reservations:[],counts:{},providerInterceptions:0,reserveAttempts:[],reportedCharge:charge};observations.push(o);
  const transport=async(url:any,init:RequestInit={})=>{
   if(String(url)==='https://ai.potens.ai/api/chat'){
    check(init.method==='POST'&&o.reservations.length===1,'CAPS_PROVIDER_AFTER_RESERVE');
    const reservation=o.reservations[0],wire=JSON.parse(String(init.body));
    check(!reservation.dispatched&&new Headers(init.headers).get('authorization')==='Bearer synthetic-ai-'+reservation.accountId,'CAPS_PROVIDER_IDENTITY');
    check(wire.model==='claude-5-sonnet'&&wire.synthetic_max_output_tokens===800&&typeof wire.prompt==='string','CAPS_PROVIDER_WIRE');
    check(!wire.prompt.includes('AI_PRIVATE_MEETING_CANARY'),'CAPS_PROVIDER_PRIVACY');
    reservation.dispatched=true;o.providerInterceptions++;
    check(reservation.accountId===target,'CAPS_PROVIDER_EXPECTED_ACCOUNT');
    if(loss)throw new Error('AI_SYNTHETIC_RESPONSE_LOSS');
    return new Response(JSON.stringify({message:JSON.stringify({status:'search',filters:{target:'posts',region:'서울특별시',query:f.aiQuery,mbti:'INFP'}}),token_usage:{fixture_input:charge-1,fixture_output:1}}),{status:200,headers:{'content-type':'application/json'}});
   }
   const u=new URL(String(url)),headers=new Headers(init.headers);check(u.origin===f.origin,'CAPS_RPC_ORIGIN');
   const name=u.pathname==='/auth/v1/user'?'auth':u.pathname.split('/').at(-1)!;
   const internal=['acquire_ai_chat_request','reserve_ai_chat_account_model','settle_ai_account_budget','record_ai_chat_result_available','finish_ai_chat_request'];
   check(name==='auth'||internal.includes(name)||['get_my_profile_traits','search_public_posts_v2','get_post_author_traits'].includes(name),'CAPS_RPC_ALLOWLIST');
   check(init.method===(name==='auth'?'GET':'POST'),'CAPS_RPC_METHOD');
   check(headers.get('authorization')==='Bearer '+(internal.includes(name)?f.service:token),'CAPS_RPC_JWT');
   const args=name==='auth'?{}:JSON.parse(String(init.body));
   if(internal.includes(name)&&name!=='settle_ai_account_budget')check(args.p_user_id===uid,'CAPS_MEMBER_SCOPE');
   const request=o.requests[0];
   if(name==='reserve_ai_chat_account_model')check(request?.acquireStatus==='acquired'&&request.requestId===args.p_request_id&&request.leaseSha256===hash(args.p_lease_token)&&args.p_ledger_id===f.aiLedgerId&&args.p_task==='intent'&&args.p_provider_id==='potens'&&args.p_contract_version==='2026-10-05'&&Number.isSafeInteger(args.p_units)&&args.p_units>0,'CAPS_RESERVE_SCOPE');
   if(name==='settle_ai_account_budget'){
    const r=o.reservations[0];check(r?.dispatched&&!r.settled&&r.reservationId===args.p_reservation_id&&r.accountId===args.p_account_id&&r.accountDay===args.p_account_day,'CAPS_SETTLE_SCOPE');
    check(args.p_outcome===(loss?'usage_unknown':'usage_reported')&&(loss?args.p_input_tokens===null&&args.p_output_tokens===null:args.p_input_tokens===charge-1&&args.p_output_tokens===1),'CAPS_SETTLE_USAGE');
   }
   if(['record_ai_chat_result_available','finish_ai_chat_request'].includes(name))check(request?.requestId===args.p_request_id&&request.leaseSha256===hash(args.p_lease_token),'CAPS_FINISH_SCOPE');
   o.counts[name]=(o.counts[name]??0)+1;const response=await localOnly(url,init);
   if(name!=='auth'){
    check(response.status===200,'CAPS_ACTUAL_RPC_HTTP');const value=await response.clone().json();
    if(name==='acquire_ai_chat_request')o.requests.push({requestId:args.p_request_id,acquireStatus:value.status,...(value.status==='acquired'?{leaseSha256:hash(value.leaseToken)}:{})});
    if(name==='reserve_ai_chat_account_model'){
     check(['reserved','account_budget_denied','global_budget_denied'].includes(value.status),'CAPS_RESERVE_STATUS');
     o.reserveAttempts.push({accountId:args.p_account_id,status:value.status,units:args.p_units});
     if(value.status==='reserved'){check(value.accountId===target&&value.accountDay===f.aiCapDay,'CAPS_STORED_RESERVE_DAY_ACCOUNT');o.reservations.push({reservationId:value.reservationId,accountId:value.accountId,accountDay:value.accountDay,requestId:args.p_request_id,units:args.p_units,dispatched:false,settled:false});}}
    if(name==='settle_ai_account_budget')o.reservations[0].settled=true;
    if(name==='search_public_posts_v2')check(value.items.length===0&&value.nextCursor===null,'CAPS_REAL_EMPTY_SEARCH');
   }
   return response;
  };
  const handler=createAiChatRuntime((key:string)=>env[key],transport,{privacy:{decisionId:'synthetic-local-only',check:async()=>true},outputLimit:{decisionId:'synthetic-wire-only',apply:(body:any,limit:number)=>({...body,synthetic_max_output_tokens:limit})}});
  const response=await handler(new Request(f.origin+'/functions/v1/ai-chat',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({clientRequestId:randomUUID().replace(/[0-9]/g,d=>String.fromCharCode(103+Number(d))),messages:[{role:'user',content:'AI_DIALOGUE_CANARY 합성 한도 탐색'}],currentFilters:{target:'posts',region:'서울특별시',query:f.aiQuery,mbti:'INFP'}})}));
  const data=(await response.json()).data;check(response.status===200&&data.requestId===response.headers.get('x-request-id')&&data.cards.length===0&&data.explanations.length===0,'CAPS_HTTP_RECEIPT');
  o.result={httpStatus:response.status,status:data.status,requestId:data.requestId,...(data.recovery?{recoveryReason:data.recovery.reason}:{}),outputSha256:hash(JSON.stringify(data))};
  if(denied){check(data.status==='unavailable'&&data.recovery?.reason==='temporary'&&o.requests[0]?.acquireStatus==='acquired'&&o.reserveAttempts.length===1&&o.reserveAttempts[0].status==='global_budget_denied'&&!o.reservations.length&&!o.providerInterceptions&&o.counts.finish_ai_chat_request===1&&!o.counts.record_ai_chat_result_available,'CAPS_DENIAL_NO_MODEL_OR_COUNT');}
  else{check(data.status===(loss?'unavailable':'no_results')&&o.requests[0]?.acquireStatus==='acquired'&&o.providerInterceptions===1&&o.reservations.length===1&&o.reservations[0].settled&&o.counts.finish_ai_chat_request===1&&(o.counts.record_ai_chat_result_available??0)===(loss?0:1),'CAPS_ACTUAL_LIFECYCLE');}
  return o;
 };
 globalThis.fetch=localOnly;
 try{
  check(/^\d{4}-\d{2}-\d{2}$/.test(f.aiCapDay)&&accountIds.every(id=>Number.isSafeInteger(f.aiCapHeadroom?.[id])&&f.aiCapHeadroom[id]>0&&f.aiCapHeadroom[id]<=3200000),'CAPS_PREPARED_HEADROOM');
  check(['unknown','fill'].includes(f.aiCapPhase),'CAPS_EXPLICIT_PHASE');
  if(f.aiCapPhase==='unknown'){await invoke('unknown-preserved','yumi',0,true);check(nativeExternalAttempts===0,'CAPS_EXTERNAL_ZERO');return {status:'PASS',case:'ai-caps-unknown',observations,nativeExternalAttempts};}
  const unknownUnits=f.aiCapUnknownUnits;check(Number.isSafeInteger(unknownUnits)&&unknownUnits>0,'CAPS_ORIGINAL_UNKNOWN_UNITS');
  for(const [index,id]of accountIds.entries()){
   const charge=f.aiCapHeadroom[id]-(index===0?unknownUnits:0);
   check(charge>0,'CAPS_NATURAL_HEADROOM_AVAILABLE');
   const o=await invoke('fill-'+id,id,charge);
   check(o.reserveAttempts.length===index+1&&o.reserveAttempts.every((attempt:any,j:number)=>attempt.accountId===accountIds[j]&&attempt.status===(j===index?'reserved':'account_budget_denied')),'CAPS_ACCOUNT_DENIAL_THEN_FALLBACK');
   check(o.reservations[0].units<=charge,'CAPS_RESERVATION_FITS_HEADROOM');
  }
  await invoke('global-denied',null,0,false,true);
  check(nativeExternalAttempts===0&&observations.length===5,'CAPS_EXTERNAL_ZERO_AND_COUNT');
  return {status:'PASS',case:'ai-caps',observations,nativeExternalAttempts,modelScope:'EXPLICIT_SYNTHETIC_IN_MEMORY_ADAPTER',syntheticUsageOnly:true,actualWallClockMidnight:'NOT_RUN',realProviderQualityAccountCostResetSharedUseLegalMemberLogin:'NOT_RUN',rawPromptModelResponseLogged:false};
 }finally{globalThis.fetch=native;}
}
