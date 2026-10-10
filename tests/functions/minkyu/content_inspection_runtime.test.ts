import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRuntimeHandler} from '../../../backend/supabase/functions/service-api/index.ts';
const user='11111111-1111-4111-8111-111111111111',operationId='33333333-3333-4333-8333-333333333333',ticketId='44444444-4444-4444-8444-444444444444';
const ready={approved:true as const,decisionId:'test',policyVersion:'test',scannerVersion:'test'};
const vals={SUPABASE_URL:'https://runtime.example.invalid',SUPABASE_ANON_KEY:'fixture-anon',SUPABASE_SERVICE_ROLE_KEY:'fixture-service',INTERNAL_WORKER_SECRET:'fixture_secret_longer_than_32_characters',ALLOWED_ORIGINS:'["https://client.example.invalid"]',MAX_REQUEST_BYTES:'65536',UPSTREAM_TIMEOUT_MS:'1000'};
const rpcInput={p_interests:['독서'],p_conversation_styles:[],p_mbti:null};
const writeBody={interests:['독서'],conversationStyles:[],mbti:null};
function request(path:string,body:unknown,headers:Record<string,string>={}){return new Request(vals.SUPABASE_URL+'/functions/v1/service-api'+path,{method:'POST',headers:{authorization:'Bearer synthetic.token.signature','content-type':'application/json',...headers},body:JSON.stringify(body)});}
async function fixture(run:(f:any)=>Promise<void>){const saved=globalThis.fetch,calls:any[]=[],classifications:any[]=[];globalThis.fetch=async(url,init)=>{
 const name=String(url).split('/').at(-1);calls.push({name,body:init?.body?JSON.parse(String(init.body)):null,headers:new Headers(init?.headers)});
 if(String(url).endsWith('/auth/v1/user'))return Response.json({id:user,role:'authenticated'});
 if(name==='issue_content_inspection_ticket')return Response.json({ticketId,userId:user,operationId,action:'profile_traits',targetId:user});
 if(name==='get_my_content_inspection_ticket')return Response.json({ticketId,userId:user,operationId,action:'profile_traits',targetId:user,decision:'allow',confirmed:false,consumed:false,expiresAt:'2099-01-01T00:00:00Z'});
 if(name==='set_my_profile_traits')return Response.json({interests:['독서'],conversationStyles:[],mbti:null});
 throw new Error('unplanned');
 };try{const read=(k:string)=>(vals as Record<string,string>)[k];const classifier={inspect:async(input:any)=>{classifications.push(input);return {decision:'allow' as const,reasons:[]};}};await run({read,calls,classifications,classifier});}finally{globalThis.fetch=saved;}}
test('기본 runtime은 검사 endpoint를 설치하지 않고 기존 작성 계약을 보존한다',async()=>fixture(async({read,calls,classifications}:any)=>{
 const handler=createRuntimeHandler(read);assert.equal((await handler(request('/content-inspections',{rpc:'set_my_profile_traits',operationId,input:rpcInput}))).status,404);assert.equal(calls.length,0);
 assert.equal((await handler(request('/me/traits',writeBody))).status,200);assert.deepEqual(calls.map((c:any)=>c.name),['user','set_my_profile_traits']);assert.equal(classifications.length,0);
}));
test('명시적으로 승인된 조립에서 inspection과 원 JWT의 저장 gate가 같은 제품 entrypoint에 연결된다',async()=>fixture(async({read,calls,classifications,classifier}:any)=>{
 const handler=createRuntimeHandler(read,{contentInspection:{readiness:ready,classifier}});
 const response=await handler(request('/content-inspections',{rpc:'set_my_profile_traits',operationId,input:rpcInput}));assert.equal(response.status,200);const r=await response.json();assert.equal(response.headers.get('x-request-id'),r.requestId);assert.equal(r.data.ticketId,ticketId);assert.equal(classifications.length,1);
 calls.length=0;const saved=await handler(request('/me/traits',writeBody,{'x-content-operation-id':operationId,'x-content-inspection-ticket':ticketId}));assert.equal(saved.status,200);assert.deepEqual(calls.map((c:any)=>c.name),['user','get_my_content_inspection_ticket','set_my_profile_traits']);assert.equal(calls[2].headers.get('x-content-inspection-ticket'),ticketId);assert.equal(calls[2].headers.get('authorization'),'Bearer synthetic.token.signature');
}));
test('승인 조립의 ticket 없는 작성은 조회와 저장 전에 차단한다',async()=>fixture(async({read,calls,classifier}:any)=>{
 const handler=createRuntimeHandler(read,{contentInspection:{readiness:ready,classifier}});assert.equal((await handler(request('/me/traits',writeBody))).status,400);assert.deepEqual(calls.map((c:any)=>c.name),['user']);
}));
test('신뢰된 조립의 false·누락·불명확한 버전은 생성 단계부터 거절한다',async()=>fixture(async({read,classifier,calls}:any)=>{
 for(const readiness of [{...ready,approved:false},{...ready,policyVersion:''},null])assert.throws(()=>createRuntimeHandler(read,{contentInspection:{readiness,classifier}} as any));assert.equal(calls.length,0);
}));
test('브라우저 preflight는 결합용 두 헤더만 추가하며 caller 승인 헤더는 허용하지 않는다',async()=>fixture(async({read,calls}:any)=>{
 const handler=createRuntimeHandler(read);
 const options=(headers:string)=>new Request(vals.SUPABASE_URL+'/functions/v1/service-api/me/traits',{method:'OPTIONS',headers:{origin:'https://client.example.invalid','access-control-request-method':'POST','access-control-request-headers':headers}});
 assert.equal((await handler(options('authorization,content-type,x-content-operation-id,x-content-inspection-ticket'))).status,204);assert.equal((await handler(options('x-content-approved'))).status,403);assert.equal(calls.length,0);
}));
