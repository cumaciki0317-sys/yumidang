/** 민규: 본인 목록 숨김의 HTTP/Auth/고정 RPC 경계를 가상 네트워크로 검사한다. 실제 RLS는 별도 SQL/통합 검사다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
import { requirePrincipal } from "../../../backend/supabase/functions/_shared/auth/principal.ts";
import { createPublicClient } from "../../../backend/supabase/functions/_shared/db/public-client.ts";
import { createInternalClient } from "../../../backend/supabase/functions/_shared/db/internal-client.ts";
import { createUserClient } from "../../../backend/supabase/functions/_shared/db/user-client.ts";
import { resolveRouteForMethod } from "../../../backend/supabase/functions/service-api/routes.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";

const API="http://127.0.0.1:56521", ORIGIN="http://127.0.0.1:5173";
const ID="11111111-1111-4111-8111-111111111111", USER="22222222-2222-4222-8222-222222222222";
const ANON="synthetic-anon", SERVICE="synthetic-service", TOKEN="synthetic.member.signature", SECRET="synthetic_worker_"+"b".repeat(32);
const config={supabaseUrl:API,supabaseAnonKey:ANON,supabaseServiceRoleKey:SERVICE,internalWorkerSecret:SECRET,
  allowedOrigins:[ORIGIN],maxRequestBytes:8192,upstreamTimeoutMs:1000};
const result={requestId:ID,hidden:true};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
type Call={path:string;method:string;headers:Headers;body:unknown};
async function probe(run:(handler:ReturnType<typeof createRuntimeHandler>,calls:Call[])=>Promise<void>,
  options:{authStatus?:number;authBody?:unknown;authThrow?:boolean;rpcStatus?:number;rpcBody?:unknown}={}) {
  const previous=globalThis.fetch,calls:Call[]=[];
  globalThis.fetch=async(input,init)=>{
    const url=new URL(typeof input==="string"?input:input instanceof URL?input.href:input.url);
    assert.equal(url.origin,API); assert.equal(init?.redirect,"error");
    calls.push({path:url.pathname,method:init?.method??"GET",headers:new Headers(init?.headers),body:init?.body?JSON.parse(String(init.body)):null});
    if(url.pathname==="/auth/v1/user") {
      if(options.authThrow) throw new Error("RAW_SYNTHETIC_PRIVATE_ERROR");
      return json(Object.hasOwn(options,"authBody")?options.authBody:{id:USER,role:"authenticated",is_anonymous:false},options.authStatus??200);
    }
    assert.ok(url.pathname.startsWith("/rest/v1/rpc/"));
    return json(options.rpcBody??result,options.rpcStatus??200);
  };
  try {
    const env:Record<string,string>={SUPABASE_URL:API,SUPABASE_ANON_KEY:ANON,SUPABASE_SERVICE_ROLE_KEY:SERVICE,
      INTERNAL_WORKER_SECRET:SECRET,ALLOWED_ORIGINS:JSON.stringify([ORIGIN]),MAX_REQUEST_BYTES:"65536",UPSTREAM_TIMEOUT_MS:"1000"};
    await run(createRuntimeHandler(key=>env[key]),calls);
  } finally {globalThis.fetch=previous;}
}
function request(path=`/service-api/conversations/${ID}/leave`,method="POST",body:unknown={},token:string|null=TOKEN,headers:Record<string,string>={}) {
  return new Request(API+path,{method,headers:{origin:ORIGIN,...(token===null?{}:{authorization:"Bearer "+token}),
    ...(method==="POST"?{"content-type":"application/json"}:{}),...headers},...(method==="POST"?{body:JSON.stringify(body)}:{})});
}
async function failure(response:Response,status:number,code:string) {
  assert.equal(response.status,status); const body=await response.json(); assert.equal(body.error.code,code);
  assert.equal(body.data,undefined); assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal(body.requestId,response.headers.get("x-request-id"));
  for(const secret of [TOKEN,SERVICE,SECRET,"RAW_SYNTHETIC_PRIVATE_ERROR"]) assert.ok(!JSON.stringify(body).includes(secret));
}

test("두 정확한 POST 경로는 기존 회원 JWT와 빈 입력으로 나가기 RPC만 호출한다",async()=>{
  await probe(async(handler,calls)=>{
    for(const prefix of ["/service-api","/functions/v1/service-api"]) {
      // 네이버 자격 필드 없는 기존 회원도 Auth 검증 후 RPC를 호출한다. 자격을 별도 요구하지 않는다.
      for(let retry=0;retry<2;retry++) {
        const response=await handler(request(`${prefix}/conversations/${ID}/leave`));
        assert.equal(response.status,200); assert.deepEqual((await response.json()).data,result);
        assert.equal(response.headers.get("access-control-allow-origin"),ORIGIN); assert.equal(response.headers.get("cache-control"),"no-store");
      }
    }
    assert.equal(calls.length,8);
    for(let i=0;i<calls.length;i+=2) {
      assert.equal(calls[i].path,"/auth/v1/user");
      assert.equal(calls[i+1].path,"/rest/v1/rpc/leave_conversation"); assert.equal(calls[i+1].method,"POST");
      assert.deepEqual(calls[i+1].body,{p_request_id:ID});
      for(const call of [calls[i],calls[i+1]]) {
        assert.equal(call.headers.get("apikey"),ANON); assert.equal(call.headers.get("authorization"),"Bearer "+TOKEN);
      }
    }
  });
});

test("비로그인·잘못된 토큰·익명/서버 키는 공개나 내부 인증으로 대체되지 않는다",async()=>{
  await probe(async(handler,calls)=>{
    for(const token of [null,"", "malformed", ANON,SERVICE,SECRET]) await failure(await handler(request(undefined,"POST",{},token)),401,"AUTH_REQUIRED");
    assert.equal(calls.length,0);
  });
  for(const authBody of [{id:USER,role:"authenticated",is_anonymous:true},{id:USER,role:"service_role"},{id:"bad",role:"authenticated"}])
    await probe(async(handler,calls)=>{
      await failure(await handler(request()),401,"AUTH_REQUIRED"); assert.deepEqual(calls.map(c=>c.path),["/auth/v1/user"]);
    },{authBody});
});

test("Auth 거절·장애는 실패로 유지하고 나가기 RPC나 익명 fallback을 실행하지 않는다",async()=>{
  for(const options of [{authStatus:401},{authStatus:403},{authStatus:503},{authThrow:true}]) await probe(async(handler,calls)=>{
    const denied=options.authStatus===401||options.authStatus===403;
    await failure(await handler(request()),denied?401:503,denied?"AUTH_REQUIRED":"EXTERNAL_UNAVAILABLE");
    assert.deepEqual(calls.map(c=>c.path),["/auth/v1/user"]);
  },options);
});

test("UUID·정확 경로·메서드 검증은 인증 전에 실패하며 복귀 경로는 없다",async()=>{
  await probe(async(handler,calls)=>{
    for(const id of ["invalid",ID+"'", "null"]) await failure(await handler(request(`/service-api/conversations/${id}/leave`)),400,"INVALID_REQUEST");
    for(const path of [`/service-api/conversations/${ID}/leave/extra`,`/service-api/conversations/${ID}/leave/`,
      `/evil/service-api/conversations/${ID}/leave`,`/service-api/conversations/%31${ID.slice(1)}/leave`,
      `/service-api/conversations//${ID}/leave`,`/service-api/conversations/${ID}/restore`])
      await failure(await handler(request(path)),404,"RESOURCE_NOT_FOUND");
    for(const method of ["GET","DELETE","PUT","PATCH","HEAD"]) await failure(await handler(request(undefined,method)),405,"METHOD_NOT_ALLOWED");
    assert.equal(calls.length,0);
    const route=resolveRouteForMethod(new URL(API+`/service-api/conversations/${ID}/leave`),"POST");
    assert.equal(route.internal,false); assert.equal(route.publicPostDetail,undefined);
  });
});

test("본문과 query의 호출자·권한·복귀 주입은 RPC 전에 거절한다",async()=>{
  await probe(async(handler,calls)=>{
    for(const body of [null,[],1,"",{userId:USER},{hidden:false},{requestId:ID},{restore:true},{__proto__:null,role:"service_role"}])
      await failure(await handler(request(undefined,"POST",body)),400,"INVALID_REQUEST");
    for(const query of ["?userId="+USER,"?hidden=false","?rpc=leave_conversation","?x=1&x=2"])
      await failure(await handler(request(`/service-api/conversations/${ID}/leave${query}`)),400,"INVALID_REQUEST");
    assert.ok(calls.every(c=>c.path==="/auth/v1/user"));
  });
});

test("JSON 형식·크기와 CORS 경계는 공통 처리하며 오류 원문을 노출하지 않는다",async()=>{
  await probe(async(handler,calls)=>{
    await failure(await handler(request(undefined,"POST",{},TOKEN,{"content-type":"text/plain"})),415,"UNSUPPORTED_MEDIA_TYPE");
    await failure(await handler(request(undefined,"POST",{},TOKEN,{"content-encoding":"gzip"})),415,"UNSUPPORTED_MEDIA_TYPE");
    await failure(await handler(request(undefined,"POST",{},TOKEN,{"content-length":"65537"})),413,"PAYLOAD_TOO_LARGE");
    await failure(await handler(request(undefined,"POST",{extra:"x".repeat(65536)})),413,"PAYLOAD_TOO_LARGE");
    for(const body of [undefined,"{"]) {
      const input=new Request(API+`/service-api/conversations/${ID}/leave`,{method:"POST",
        headers:{origin:ORIGIN,authorization:"Bearer "+TOKEN,"content-type":"application/json"},...(body===undefined?{}:{body})});
      await failure(await handler(input),400,"INVALID_REQUEST");
    }
    assert.ok(calls.every(c=>c.path==="/auth/v1/user"));
    const before=calls.length;
    const blocked=await handler(request(undefined,"POST",{},TOKEN,{origin:"https://blocked.example.invalid"}));
    await failure(blocked,403,"ACCESS_DENIED"); assert.equal(blocked.headers.get("access-control-allow-origin"),null);
    const preflight=await handler(request(undefined,"OPTIONS",undefined,null,{"access-control-request-method":"POST","access-control-request-headers":"authorization,content-type"}));
    assert.equal(preflight.status,204); assert.equal(preflight.headers.get("access-control-allow-origin"),ORIGIN);
    await failure(await handler(request(undefined,"OPTIONS",undefined,null,{"access-control-request-method":"POST","access-control-request-headers":"x-user-id"})),403,"ACCESS_DENIED");
    assert.equal(calls.length,before);
  });
});

test("당사자·부재·guest 등 RPC 오류는 공통 상태로 매핑하고 실패를 숨김 성공으로 만들지 않는다",async()=>{
  for(const [code,status,errorCode] of [["P0002",404,"RESOURCE_NOT_FOUND"],["42501",403,"ACCESS_DENIED"],
    ["28000",401,"AUTH_REQUIRED"],["40P01",503,"EXTERNAL_UNAVAILABLE"]] as const)
    await probe(async(handler,calls)=>{
      await failure(await handler(request()),status,errorCode); assert.equal(calls.length,2);
      assert.equal(calls[1].path,"/rest/v1/rpc/leave_conversation");
    },{rpcStatus:500,rpcBody:{code,message:"RAW_SYNTHETIC_PRIVATE_ERROR",details:"RAW_SYNTHETIC_PRIVATE_ERROR"}});
});

test("나가기 RPC는 사용자 client만 허용하고 공개·내부·spoof RPC는 요청하지 않는다",async()=>{
  const noNetwork:typeof fetch=async()=>assert.fail("unexpected network");
  const principal=await requirePrincipal(new Request(API,{headers:{authorization:"Bearer "+TOKEN}}),config,
    async()=>json({id:USER,role:"authenticated",is_anonymous:false}));
  const user=createUserClient(config,principal,noNetwork),publicDb=createPublicClient(config,noNetwork),internal=createInternalClient(config,noNetwork);
  const denied=(error:unknown)=>{assert.equal(toPublicError(error).error.code,"ACCESS_DENIED");return true;};
  await assert.rejects(publicDb.rpc("leave_conversation",{p_request_id:ID}),denied);
  await assert.rejects(internal.rpc("leave_conversation",{p_request_id:ID}),denied);
  for(const name of ["leave_conversation?select=*","leave_conversation/..","LEAVE_CONVERSATION","restore_conversation","conversation_visibility"])
    await assert.rejects(user.rpc(name,{p_request_id:ID}),denied);
});

test("목록·상세·메시지·전송은 기존 RPC와 입력을 유지한다",async()=>{
  await probe(async(handler,calls)=>{
    for(const [path,method,body,name,args] of [
      ["/conversations","GET",undefined,"list_conversations_with_read_state",{}],
      [`/conversations/${ID}`,"GET",undefined,"get_conversation_with_read_state",{p_request_id:ID}],
      [`/conversations/${ID}/messages?limit=20`,"GET",undefined,"list_conversation_messages",{p_request_id:ID,p_limit:20,p_before:null}],
      [`/conversations/${ID}/messages`,"POST",{messageId:USER,content:"합성 기존 메시지"},"send_conversation_message",{p_request_id:ID,p_message_id:USER,p_content:"합성 기존 메시지"}],
    ] as const) {
      assert.equal((await handler(request("/service-api"+path,method,body))).status,200);
      const last=calls.at(-1)!; assert.equal(last.path,"/rest/v1/rpc/"+name); assert.deepEqual(last.body,args);
    }
    assert.equal(calls.length,8);
  });
});
