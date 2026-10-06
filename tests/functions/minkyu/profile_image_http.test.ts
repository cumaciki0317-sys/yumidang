/** 민규담당. 모형 HTTP만 사용하며 실제 Auth/Storage 증거와 구분한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProfileImageExecutor, profileImageRoutePath, MAX_PROFILE_IMAGE_BYTES } from "../../../backend/supabase/functions/service-api/profile-image-http.ts";
import { createServiceApi } from "../../../backend/supabase/functions/service-api/handler.ts";
import { toPublicError } from "../../../backend/supabase/functions/_shared/http/errors.ts";
import type { RuntimeConfig } from "../../../backend/supabase/functions/_shared/config/env.ts";
import type { FetchLike } from "../../../backend/supabase/functions/_shared/db/transport.ts";
const uid="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", path=uid+"/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg";
const token="header.auth_verified.signature", api="https://project.example.test";
const config={supabaseUrl:api,supabaseAnonKey:"public-anon",supabaseServiceRoleKey:"private-service",internalWorkerSecret:"private-internal",upstreamTimeoutMs:1000} as RuntimeConfig;
const photo=new Uint8Array([255,216,255,224,0,255,217]);
const request=(suffix="",init: RequestInit={})=>new Request("https://api.example.test/service-api/profile-images/"+path+suffix,{headers:{authorization:"Bearer "+token},...init});
function scenario(options:{getStatus?:number;headStatus?:number;body?:Uint8Array;type?:string;authStatus?:number;length?:string}={}) {
  const calls:Array<{url:string;method:string;headers:Headers}> = [];
  const fetcher:FetchLike=async(url,init={})=>{
    calls.push({url:String(url),method:init.method??"GET",headers:new Headers(init.headers)});
    if(String(url)===api+"/auth/v1/user") return new Response(JSON.stringify({id:uid,role:"authenticated",is_anonymous:false}),{status:options.authStatus??200,headers:{"content-type":"application/json"}});
    assert.equal(String(url),api+"/storage/v1/object/authenticated/profile-images/"+path);
    assert.equal(new Headers(init.headers).get("authorization"),"Bearer "+token);
    assert.equal(new Headers(init.headers).get("apikey"),"public-anon");
    assert.equal(init.redirect,"error"); assert.equal(init.cache,"no-store");
    if(init.method==="HEAD") return new Response(null,{status:options.headStatus??200,headers:{"cache-control":"public,max-age=3600","etag":"private-upstream"}});
    const headers:Record<string,string>={"content-type":options.type??"image/jpeg","cache-control":"public,max-age=3600","etag":"private-upstream","set-cookie":"private-upstream","location":"https://forbidden.example/"};
    if(options.length!==undefined) headers["content-length"]=options.length;
    return new Response(new Uint8Array(options.body??photo).buffer,{status:options.getStatus??200,headers});
  };
  return{run:createProfileImageExecutor(config,fetcher),calls};
}
async function rejected(run:ReturnType<typeof createProfileImageExecutor>,req:Request,code:string) {
  await assert.rejects(()=>run(req,path),(error)=>toPublicError(error).error.code===code);
}
test("photo bytes require Auth then user JWT GET then HEAD; private headers never forwarded",async()=>{
  const s=scenario();const r=await s.run(request(),path);
  assert.equal(r.status,200);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),photo);
  assert.deepEqual(s.calls.map(x=>x.method),["GET","GET","HEAD"]);
  assert.equal(r.headers.get("cache-control"),"private, no-store");assert.equal(r.headers.get("vary"),"Authorization, Origin");
  for(const name of["etag","last-modified","set-cookie","location"])assert.equal(r.headers.get(name),null);
});
test("retirement between GET and HEAD discards fetched bytes",async()=>{
  const s=scenario({headStatus:403});await rejected(s.run,request(),"RESOURCE_NOT_FOUND");assert.equal(s.calls.length,3);
});
test("auth refusal never falls back to service key or Storage",async()=>{
  const s=scenario({authStatus:401});await rejected(s.run,request(),"AUTH_REQUIRED");assert.equal(s.calls.length,1);
});
test("missing auth and forbidden paths/queries/method/range never reach upstream",async()=>{
  const s=scenario();await rejected(s.run,request("",{headers:{}}),"AUTH_REQUIRED");
  for(const suffix of["?token=forbidden","?download=1","#forbidden"])await rejected(s.run,request(suffix),"INVALID_REQUEST");
  await rejected(s.run,request("",{method:"POST"}),"METHOD_NOT_ALLOWED");
  await rejected(s.run,request("",{headers:{authorization:"Bearer "+token,range:"bytes=0-1"}}),"INVALID_REQUEST");
  await assert.rejects(()=>s.run(request(),"../"+path),(e)=>toPublicError(e).error.code==="INVALID_REQUEST");
  assert.equal(s.calls.length,0);
});
test("bad MIME, malformed JPEG, advertised mismatch and oversized stream reject before HEAD",async()=>{
  for(const opts of[{type:"image/png"},{body:new Uint8Array([1,2,3,4,5])},{length:"999"},{length:String(MAX_PROFILE_IMAGE_BYTES+1)},{body:new Uint8Array(MAX_PROFILE_IMAGE_BYTES+1)}]){
    const s=scenario(opts);await rejected(s.run,request(),"EXTERNAL_UNAVAILABLE");assert.equal(s.calls.length,2);
  }
});
test("Storage refusal and HEAD outage remain failure with no image response",async()=>{
  for(const status of[400,401,403,404]){const s=scenario({getStatus:status});await rejected(s.run,request(),"RESOURCE_NOT_FOUND");assert.equal(s.calls.length,2);}
  const s=scenario({headStatus:503});await rejected(s.run,request(),"EXTERNAL_UNAVAILABLE");
});
test("already aborted request is rejected before upstream",async()=>{
  const s=scenario();const c=new AbortController();c.abort();await rejected(s.run,request("",{signal:c.signal}),"EXTERNAL_UNAVAILABLE");assert.equal(s.calls.length,0);
});
test("only fixed service-api photo prefixes match",()=>{
  assert.equal(profileImageRoutePath(new URL("https://x.example/functions/v1/service-api/profile-images/"+path)),path);
  assert.equal(profileImageRoutePath(new URL("https://x.example/service-api/profile-images/"+path)),path);
  assert.equal(profileImageRoutePath(new URL("https://x.example/profile-images/"+path)),null);
});

test("client validators cannot skip user authorization or return304",async()=>{
 const s=scenario();const req=request("",{headers:{authorization:"Bearer "+token,"if-none-match":"old-user-photo","if-modified-since":"Wed, 01 Jan 2020 00:00:00 GMT"}});
 const r=await s.run(req,path);assert.equal(r.status,200);
 for(const call of s.calls){assert.equal(call.headers.get("if-none-match"),null);assert.equal(call.headers.get("if-modified-since"),null);}
});

function service(s:ReturnType<typeof scenario>) {
 return createServiceApi({allowedOrigins:["https://app.example.test"],maxBodyBytes:8192,profileImages:{execute:s.run},
   authenticateUser:async()=>assert.fail("photo must use dedicated verified user JWT executor"),
   authenticateInternal:async()=>assert.fail("photo must never enter internal authentication")});
}
test("service-api photo route preserves CORS, no-store, Authorization Vary and request ID",async()=>{
 const s=scenario();const r=await service(s)(request("",{headers:{authorization:"Bearer "+token,origin:"https://app.example.test"}}));
 assert.equal(r.status,200);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),photo);
 assert.equal(r.headers.get("access-control-allow-origin"),"https://app.example.test");
 assert.equal(r.headers.get("cache-control"),"private, no-store");assert.equal(r.headers.get("vary"),"Authorization, Origin");
 assert.match(r.headers.get("x-request-id")!,/^[0-9a-f-]{36}$/);
});
test("service-api post-read revocation returns no-store JSON error instead of photo",async()=>{
 const s=scenario({headStatus:403});const r=await service(s)(request());assert.equal(r.status,404);
 assert.equal(r.headers.get("cache-control"),"no-store");assert.ok(r.headers.get("content-type")?.startsWith("application/json"));
 const body=await r.json();assert.equal(body.error.code,"RESOURCE_NOT_FOUND");assert.equal(JSON.stringify(body).includes(path),false);
});
test("forbidden Origin cannot enter photo executor",async()=>{
 const s=scenario();const r=await service(s)(request("",{headers:{authorization:"Bearer "+token,origin:"https://forbidden.example"}}));
 assert.equal(r.status,403);assert.equal(s.calls.length,0);assert.equal((await r.json()).error.code,"ACCESS_DENIED");
});
