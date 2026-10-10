/** 민규: 최초 가입의 실제 factory에서 원 JWT·검사 티켓·정규화된 가입 입력을 연결한다. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSignupRuntimeHandler } from '../../../backend/supabase/functions/signup/index.ts';
const origin='https://app.example.test';
const uid='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sid='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ticketId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const operationId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const avatarPath=`${uid}/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee.jpg`;
const encode=(x:unknown)=>Buffer.from(JSON.stringify(x)).toString('base64url');
const token=`${encode({alg:'HS256'})}.${encode({sub:uid,role:'authenticated',session_id:sid})}.c2lnbmF0dXJl`;
const ready={approved:true as const,decisionId:'synthetic-fixture',policyVersion:'fixture-v1',scannerVersion:'fixture-v1'};
const env:Record<string,string>={SUPABASE_URL:'https://project.example.test',SUPABASE_ANON_KEY:'public-anon',SUPABASE_SERVICE_ROLE_KEY:'private-service',ALLOWED_ORIGINS:JSON.stringify([origin]),MAX_REQUEST_BYTES:'8192',UPSTREAM_TIMEOUT_MS:'1000',NAVER_CLIENT_ID:'client-id',NAVER_CLIENT_SECRET:'client-secret',NAVER_REDIRECT_URI:origin+'/auth/naver/callback',NAVER_STATE_TTL_SECONDS:'600'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture(approved=true,receiptOverride:Record<string,unknown>={}) {
 const calls:{path:string;method:string;headers:Headers;body:any}[]=[];
 const fetchImpl:typeof fetch=async(input,init)=>{
  const path=new URL(String(input)).pathname;
  const headers=new Headers(init?.headers),body=init?.body?JSON.parse(String(init.body)):null;
  calls.push({path,method:init?.method??'GET',headers,body});
  if(path==='/auth/v1/user')return json({id:uid,role:'authenticated',is_anonymous:false});
  if(path.endsWith('/get_my_content_inspection_ticket'))return json({ticketId,userId:uid,operationId,action:'signup_traits',targetId:uid,decision:'allow',confirmed:false,consumed:false,expiresAt:new Date(Date.now()+60000).toISOString(),...receiptOverride});
  if(path.endsWith('/complete_naver_signup'))return json({status:'ready',avatarPath,interests:[],conversationStyles:[],mbti:null});
  if(path.endsWith('/get_naver_signup_state'))return json({status:'photo_required',avatarPath:null,interests:[],conversationStyles:[],mbti:null});
  assert.fail(`unexpected endpoint ${path}`);
 };
 const handler=createSignupRuntimeHandler(key=>env[key],fetchImpl,approved?{contentInspection:ready}:{});
 const request=(path='complete',headers:Record<string,string>={},body:unknown={avatarPath})=>handler(new Request(`https://api.example.test/signup/${path}`,{method:path==='state'?'GET':'POST',headers:{origin,authorization:`Bearer ${token}`,'content-type':'application/json',...headers},...(path==='state'?{}:{body:JSON.stringify(body)})}));
 return {handler,request,calls};
}
const keys={'x-content-inspection-ticket':ticketId,'x-content-operation-id':operationId};
test('승인된 최초 가입: Auth 사용자 확인→원 JWT ticket POST 조회→같은 키와 정규화된 가입 입력 저장',async()=>{
 const f=fixture();const r=await f.request('complete',keys);assert.equal(r.status,200);
 assert.deepEqual(f.calls.map(c=>c.path),['/auth/v1/user','/rest/v1/rpc/get_my_content_inspection_ticket','/rest/v1/rpc/complete_naver_signup']);
 for(const c of f.calls.slice(1)){assert.equal(c.method,'POST');assert.equal(c.headers.get('authorization'),`Bearer ${token}`);assert.equal(c.headers.get('apikey'),'public-anon');}
 assert.deepEqual(f.calls[1].body,{p_ticket_id:ticketId,p_operation_id:operationId});
 const write=f.calls[2];for(const [key,value]of Object.entries(keys))assert.equal(write.headers.get(key),value);
 assert.deepEqual(write.body,{p_avatar_path:avatarPath,p_interests:[],p_conversation_styles:[],p_mbti:null});
 assert.equal(f.calls.some(c=>c.path.includes('profile')||c.path.includes('admin')),false);
});
test('누락 키·차단·다른 가입 대상·다른 action은 실제 가입 RPC 호출 전에 거절',async()=>{
 for(const [headers,override,status]of [[{}, {},400],[keys,{decision:'block'},403],[keys,{targetId:sid},409],[keys,{action:'profile_traits'},409]] as const){
  const f=fixture(true,override);assert.equal((await f.request('complete',headers)).status,status);assert.equal(f.calls.some(c=>c.path.endsWith('/complete_naver_signup')),false);
 }
});
test('가입 상태 읽기는 티켓 없이 가능하고 기존 비승인 factory의 완료 계약은 보존',async()=>{
 const gated=fixture();assert.equal((await gated.request('state')).status,200);assert.equal(gated.calls.length,2);
 const ordinary=fixture(false);assert.equal((await ordinary.request()).status,200);assert.equal(ordinary.calls.length,2);
 assert.equal(ordinary.calls[1].headers.has('x-content-inspection-ticket'),false);
});
test('검사 결합 헤더의 CORS 허용은 승인된 서버 조립에만 적용',async()=>{
 for(const approved of [true,false]){
  const f=fixture(approved);const r=await f.handler(new Request('https://api.example.test/signup/complete',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'authorization,content-type,x-content-operation-id,x-content-inspection-ticket'}}));
  assert.equal(r.status,approved?204:403);assert.equal(f.calls.length,0);
 }
});
test('잘못된 승인 설정은 factory 생성에서 거절하고 사용자 입력으로 설치하지 않음',()=>{
 for(const bad of [{...ready,approved:false},{...ready,decisionId:''},{...ready,scannerVersion:'invalid version'}])assert.throws(()=>createSignupRuntimeHandler(key=>env[key],fetch,{contentInspection:bad as typeof ready}));
});
