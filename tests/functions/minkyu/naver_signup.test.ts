/** 민규담당. 실제 factory의 HTTP→state→네이버→Auth→RPC 연결을 가상 상위 응답으로 검사. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSignupRuntimeHandler } from '../../../backend/supabase/functions/signup/index.ts';
import { sha256 } from '../../../backend/supabase/functions/_shared/services/signup-service.ts';
import { parseNaverStart, parseSignupCompletion, parseProfileTraits } from '../../../backend/supabase/functions/_shared/contracts/signup.ts';
import { resolveRouteForMethod } from '../../../backend/supabase/functions/service-api/routes.ts';
import { toPublicError } from '../../../backend/supabase/functions/_shared/http/errors.ts';
const origin = 'https://app.example.test';
const uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const authEmail = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc@naver.yumidang.invalid';
const avatarPath = `${uid}/dddddddd-dddd-4ddd-8ddd-dddddddddddd.jpg`;
const verifier = 'v'.repeat(43);
const encode = (x: unknown) => Buffer.from(JSON.stringify(x)).toString('base64url');
const token = `${encode({alg:'HS256'})}.${encode({sub:uid,role:'authenticated',session_id:sid})}.c2lnbmF0dXJl`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status,headers:{'content-type':'application/json'}});
const state = (status = 'photo_required') => ({status,avatarPath:status === 'ready'?avatarPath:null,interests:[],conversationStyles:[],mbti:null,secret:'never-expose'});
function fixture(options: { status?:string;failRecord?:boolean;missingConfig?:boolean } = {}) {
  const calls: {path:string;body:any;headers:Headers}[] = [];
  const challenges = new Map<string,any>();
  const env: Record<string,string> = {SUPABASE_URL:'https://project.example.test',SUPABASE_ANON_KEY:'public-anon',SUPABASE_SERVICE_ROLE_KEY:'private-service',
    ALLOWED_ORIGINS:JSON.stringify([origin,'https://other.example.test']),MAX_REQUEST_BYTES:'8192',UPSTREAM_TIMEOUT_MS:'1000',
    NAVER_CLIENT_ID:'client-id',NAVER_CLIENT_SECRET:'client-secret',NAVER_REDIRECT_URI:origin+'/auth/naver/callback',NAVER_STATE_TTL_SECONDS:'600'};
  if (options.missingConfig) delete env.NAVER_CLIENT_ID;
  const status=options.status??'photo_required';
  const account = {status,authEmail:['ineligible','information_required'].includes(status)?null:authEmail,userId:null};
  const fetchImpl:typeof fetch = async (input,init) => {
    const path=new URL(String(input)).pathname;
    const headers=new Headers(init?.headers);
    const body=init?.body ? path === '/oauth2.0/token'? Object.fromEntries(new URLSearchParams(String(init.body))):JSON.parse(String(init.body)):null;
    calls.push({path,body,headers});
    if (path === '/auth/v1/user') return headers.get('authorization') === `Bearer ${token}`?json({id:uid,role:'authenticated',is_anonymous:false}):json({},401);
    if(path.endsWith('/begin_naver_login')) {challenges.set(body.p_state_hash,body);return json({expiresAt:'2026-10-02T12:00:00Z'});}
    if(path.endsWith('/consume_naver_login')) {
      const challenge=challenges.get(body.p_state_hash);
      if(!challenge || challenge.p_verifier_hash !== body.p_verifier_hash || challenge.p_origin !== body.p_origin) return json({code:'22023',message:'private-service'},400);
      challenges.delete(body.p_state_hash);return json({returnTo:challenge.p_return_to});
    }
    if(path === '/oauth2.0/token') return json({access_token:'naver-secret-token',token_type:'bearer',expires_in:'3600'});
    if(path === '/v1/nid/me') return json({resultcode:'00',response:{id:'naver-subject',name:'네이버회원',gender:'F',birthday:'10-02',birthyear:'2000'}});
    if(path.endsWith('/resolve_naver_account')) return json(account);
    if(path === '/auth/v1/admin/generate_link') return json({id:uid,email:authEmail,hashed_token:'e'.repeat(64),verification_type:'signup'});
    if(path === '/auth/v1/verify') return json({access_token:token,refresh_token:'private-refresh',expires_in:3600,token_type:'bearer',user:{id:uid,email:authEmail,role:'authenticated',is_anonymous:false}});
    if(path.endsWith('/record_naver_session')) return options.failRecord?json({code:'23505',message:'naver-subject private-service'},409):json({...account,userId:uid});
    if(path.endsWith('/get_naver_signup_state')) return json(state());
    if(path.endsWith('/complete_naver_signup')) return json(state('ready'));
    assert.fail(`unexpected test endpoint ${path}`);
  };
  const handler=createSignupRuntimeHandler((key)=>env[key],fetchImpl);
  const request=(path:string,body?:unknown,headers:Record<string,string>={},method=body===undefined?'GET':'POST') => handler(new Request('https://api.example.test/functions/v1/signup/'+path,
    {method,headers:{origin,'content-type':'application/json',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}));
  return {calls,request,handler,challenges};
}
async function begin(f:ReturnType<typeof fixture>,headers:Record<string,string>={}) {
  const response=await f.request('naver/start',{codeChallenge:await sha256(verifier),returnTo:'/posts/123'},headers);
  assert.equal(response.status,200);
  const data=(await response.json()).data;
  return new URL(data.authorizationUrl).searchParams.get('state')!;
}
test('factory: 브라우저 proof와 origin 확인 후 네이버/Auth/DB 귀속 검증, 세션만 반환',async()=>{
  const f=fixture();const value=await begin(f);
  const response=await f.request('naver/callback',{state:value,code:'provider-code',codeVerifier:verifier});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  const wire=await response.json();assert.equal(wire.data.session.accessToken,token);assert.equal(wire.data.returnTo,'/posts/123');assert.equal(wire.data.status,'photo_required');
  assert.doesNotMatch(JSON.stringify(wire),/naver-subject|naver-secret-token|private-service|2000-10-02|hashed_token|authEmail/);
  assert.deepEqual(f.calls.map(x=>x.path),['/rest/v1/rpc/begin_naver_login','/rest/v1/rpc/consume_naver_login','/oauth2.0/token','/v1/nid/me','/rest/v1/rpc/resolve_naver_account','/auth/v1/admin/generate_link','/auth/v1/verify','/rest/v1/rpc/record_naver_session']);
  const recorded=f.calls.at(-1)!.body;assert.equal(recorded.p_session_id,sid);assert.equal(recorded.p_user_id,uid);
});
test('state 재사용·다른 verifier·다른 허용 Origin도 네이버 호출 전에 차단',async()=>{
  const f=fixture();const value=await begin(f);
  const body={state:value,code:'code',codeVerifier:verifier};
  assert.equal((await f.request('naver/callback',{...body,codeVerifier:'x'.repeat(43)})).status,400);
  assert.equal((await f.request('naver/callback',body,{origin:'https://other.example.test'})).status,400);
  assert.equal(f.calls.some(x=>x.path==='/oauth2.0/token'),false);
  assert.equal((await f.request('naver/callback',body)).status,200);
  const count=f.calls.filter(x=>x.path==='/oauth2.0/token').length;
  assert.equal((await f.request('naver/callback',body)).status,400);
  assert.equal(f.calls.filter(x=>x.path==='/oauth2.0/token').length,count);
});
test('신규 정보 누락·자격 불충족은 Auth 계정/세션 생성 없이 보류',async()=>{
  for(const status of ['information_required','ineligible']) {
    const f=fixture({status});const value=await begin(f);
    const response=await f.request('naver/callback',{state:value,code:'code',codeVerifier:verifier});
    assert.equal(response.status,200);const wire=await response.json();assert.equal(wire.data.status,status);assert.equal(wire.data.session,null);
    assert.equal(f.calls.some(x=>x.path.startsWith('/auth/')),false);
  }
});
test('DB 세션 귀속 실패 시 Auth가 발급한 토큰도 브라우저에 노출하지 않음',async()=>{
  const f=fixture({failRecord:true});const value=await begin(f);
  const response=await f.request('naver/callback',{state:value,code:'code',codeVerifier:verifier});
  assert.equal(response.status,409);assert.doesNotMatch(await response.text(),/private-refresh|private-service|naver-subject|accessToken/);
});
test('상태/완료는 실제 Auth user 검증 및 사용자 JWT RPC, 사진+선택 성향 완료',async()=>{
  const f=fixture();assert.equal((await f.request('state')).status,401);
  const response=await f.request('state',undefined,{authorization:`Bearer ${token}`});
  assert.equal(response.status,200);assert.doesNotMatch(await response.text(),/never-expose|secret/);
  const complete=await f.request('complete',{avatarPath},{authorization:`Bearer ${token}`});
  assert.equal(complete.status,200);assert.equal((await complete.json()).data.status,'ready');
  const call=f.calls.at(-1)!;assert.equal(call.headers.get('authorization'),`Bearer ${token}`);assert.equal(call.headers.get('apikey'),'public-anon');
  assert.deepEqual(call.body,{p_avatar_path:avatarPath,p_interests:[],p_conversation_styles:[],p_mbti:null});
});
test('잘못된 경로·메서드·Origin·초과 본문·누락 설정은 안전하게 실패',async()=>{
  const f=fixture();
  assert.equal((await f.request('naver/start',{})).status,400);
  assert.equal((await f.request('naver/start',{codeChallenge:'a'.repeat(64)},{origin:'https://evil.example.test'})).status,403);
  const noOrigin=await f.handler(new Request('https://api.example.test/signup/naver/start',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}));assert.equal(noOrigin.status,403);
  assert.equal((await f.request('naver/start')).status,405);
  assert.equal((await f.request('naver/start?secret=1',{})).status,404);
  assert.equal((await f.request('naver/start',{x:'x'.repeat(8193)})).status,413);
  assert.equal(f.calls.length,0);
  const missing=fixture({missingConfig:true});const response=await missing.request('naver/start',{codeChallenge:'a'.repeat(64)});
  assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/client-secret|private-service/);
});
test('공통 CORS preflight는 204 exact Origin, 비허용 Origin은 거절',async()=>{
  const f=fixture();const response=await f.handler(new Request('https://api.example.test/signup/naver/start',{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type'}}));
  assert.equal(response.status,204);assert.equal(response.headers.get('access-control-allow-origin'),origin);assert.equal(f.calls.length,0);
});
test('입력의 자격 자기신고·외부 복귀·성향 제한/MBTI 위반은 거절',()=>{
  const rejected=(fn:()=>unknown)=>assert.throws(fn,(e)=>toPublicError(e).error.code==='INVALID_REQUEST');
  for(const returnTo of ['https://evil.test','//evil.test','/\\evil.test','/%2fevil.test','/%5cevil.test','/%0aevil.test']) rejected(()=>parseNaverStart({codeChallenge:'a'.repeat(64),returnTo}));
  rejected(()=>parseSignupCompletion({avatarPath,gender:'F'}));
  rejected(()=>parseSignupCompletion({avatarPath,interests:null}));
  rejected(()=>parseProfileTraits({interests:Array(21).fill('x'),conversationStyles:[],mbti:null}));
  rejected(()=>parseProfileTraits({interests:['A','a'],conversationStyles:[],mbti:null}));
  rejected(()=>parseProfileTraits({interests:[],conversationStyles:['x'.repeat(41)],mbti:null}));
  rejected(()=>parseProfileTraits({interests:[],conversationStyles:[],mbti:'EINT'}));
});
test('성향 GET/POST는 신규 허용 RPC에 정확한 입력을 전달',async()=>{
  const calls:any[]=[];const db={rpc:async(name:string,args:any)=>{calls.push({name,args});return {interests:[],conversationStyles:[],mbti:null};}};
  const url=new URL('https://api.example.test/functions/v1/service-api/me/traits');
  await resolveRouteForMethod(url,'GET').execute({db,url,body:null});
  await resolveRouteForMethod(url,'POST').execute({db,url,body:{interests:['전시'],conversationStyles:[],mbti:'INFP'}});
  assert.deepEqual(calls,[{name:'get_my_profile_traits',args:{}},{name:'set_my_profile_traits',args:{p_interests:['전시'],p_conversation_styles:[],p_mbti:'INFP'}}]);
});
