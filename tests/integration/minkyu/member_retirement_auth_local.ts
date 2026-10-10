/** 민규: 격리 실제 GoTrue/REST만 호출한다. 응답 유실 복구의 모든 후속은 GET만 허용한다. */
import assert from "node:assert/strict";
import { readFileSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { createRuntimeHandler } from "../../../backend/supabase/functions/service-api/index.ts";
const file=process.argv[2],st=lstatSync(file),dir=lstatSync(dirname(file));
assert.ok(st.isFile()&&!st.isSymbolicLink()&&st.uid===process.getuid!()&&(st.mode&0o777)===0o600);
assert.ok(dir.isDirectory()&&!dir.isSymbolicLink()&&dir.uid===process.getuid!()&&(dir.mode&0o777)===0o700);
const input=JSON.parse(readFileSync(file,"utf8")),origin=new URL(input.origin),mode=process.argv[3]??"--legacy-initial";
assert.ok(["--legacy-initial","--retry-only","--receipt-initial","--receipt-proof","--receipt-state-denied","--auth-unavailable"].includes(mode));
assert.equal(origin.protocol,"http:");assert.equal(origin.hostname,"127.0.0.1");assert.equal(origin.origin,input.origin);
const values:Record<string,string>={SUPABASE_URL:input.origin,SUPABASE_ANON_KEY:input.anon,SUPABASE_SERVICE_ROLE_KEY:input.service,
 INTERNAL_WORKER_SECRET:"local_retirement_auth_fixture_longer_than_32_chars",ALLOWED_ORIGINS:"[]",MAX_REQUEST_BYTES:"65536",UPSTREAM_TIMEOUT_MS:"15000"};
const native=globalThis.fetch;let authCalls=0,retireCalls=0,receiptCalls=0;
const fresh=mode==="--legacy-initial"||mode==="--receipt-initial";
globalThis.fetch=async(url,init={})=>{
 const target=new URL(String(url));assert.equal(target.origin,input.origin);
 if(target.pathname==="/auth/v1/user"){assert.equal(init.method,"GET");authCalls++;}
 else if(target.pathname==="/rest/v1/rpc/get_my_retirement_receipt"&&mode!=="--retry-only"){
  assert.equal(init.method,"GET");assert.equal(init.body,undefined);receiptCalls++;
 }else{assert.ok(fresh&&target.pathname==="/rest/v1/rpc/retire_my_account");assert.equal(init.method,"POST");assert.equal(retireCalls,0);retireCalls++;}
 return native(url,init);
};
const digest=(id:string)=>createHash("sha256").update("retirement:v1:"+id).digest("hex");
const receiptUrl=(id=input.withdrawalId,fp=digest(id))=>input.origin+"/rest/v1/rpc/get_my_retirement_receipt?"+new URLSearchParams({p_withdrawal_id:id,p_request_fingerprint:fp});
const ownGet=async(token=input.token,id=input.withdrawalId,fp=digest(id))=>native(receiptUrl(id,fp),{method:"GET",headers:{apikey:input.anon,authorization:"Bearer "+token}});
const request=(token=input.token)=>new Request(input.origin+"/service-api/me/retirement",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json"},body:JSON.stringify({withdrawalId:input.withdrawalId})});
try{
 const h=createRuntimeHandler(k=>values[k],{memberCleanup:true,memberRetirement:true});
 if(fresh){
  const before=await native(input.origin+"/auth/v1/user",{headers:{apikey:input.anon,authorization:"Bearer "+input.token}});
  assert.equal(before.status,200);assert.equal((await before.json()).id,input.userId);
  const accepted=await h(request());assert.equal(accepted.status,200);
  assert.deepEqual((await accepted.json()).data,{withdrawalId:input.withdrawalId,status:"processing",memberAccessRevoked:true});
 }
 if(mode==="--auth-unavailable"){
  const response=await h(request());assert.equal(response.status,503);
  const failure=await response.json();assert.equal(failure.error.code,"EXTERNAL_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify(failure),/LOCAL_GATEWAY_FAILED|private|SQL/);
  assert.equal(authCalls,1);assert.equal(retireCalls,0);assert.equal(receiptCalls,0);
  process.stdout.write(JSON.stringify({status:"PASS",actualHttpStatus:503,authCalls,retirementRpcCalls:0,receiptGetCalls:0,retryMutationCalls:0}));
 }else{
 const after=await native(input.origin+"/auth/v1/user",{headers:{apikey:input.anon,authorization:"Bearer "+input.token}});
 assert.ok(after.status===401||after.status===403);const authStatus=after.status;await after.body?.cancel();
 if(mode==="--receipt-state-denied"){
  const denied=await ownGet();assert.ok(denied.status===401||denied.status===403);await denied.body?.cancel();
  process.stdout.write(JSON.stringify({status:"PASS",currentStateDenied:true,actualStatus:denied.status,retirementRpcCalls:0}));
 }else{
  const retry=await h(request());const expected=mode==="--receipt-proof"?200:401;assert.equal(retry.status,expected);
  const body=await retry.json();
  if(expected===200)assert.deepEqual(body.data,{withdrawalId:input.withdrawalId,status:"processing",memberAccessRevoked:true});
  else{assert.equal(body.error.code,"AUTH_REQUIRED");assert.doesNotMatch(JSON.stringify(body),new RegExp(input.userId+"|"+input.withdrawalId));}
  const negatives:{name:string;status:number}[]=[];
  if(mode==="--receipt-proof"){
   // 본 token의 서명·만료 검사는 REST가 수행한다. 아래 서명된 변형은 테스트 대조군일 뿐이다.
   for(const [name,token]of Object.entries(input.negativeTokens) as [string,string][]){
    const response=await ownGet(token);assert.ok(response.status===401||response.status===403);await response.body?.cancel();negatives.push({name,status:response.status});
   }
   for(const [name,id,fp]of [["wrong_withdrawal",input.otherWithdrawal,digest(input.otherWithdrawal)],["wrong_fingerprint",input.withdrawalId,"0".repeat(64)]]){
    const response=await ownGet(input.token,id,fp);assert.ok(response.status===401||response.status===403);await response.body?.cancel();negatives.push({name,status:response.status});
   }
   for(const name of ["wrong_signature","expired","wrong_issuer","wrong_audience","wrong_sub"]){
    const denied=await h(request(input.negativeTokens[name]));assert.equal(denied.status,401);const failure=await denied.json();assert.equal(failure.error.code,"AUTH_REQUIRED");
   }
   const none=await h(new Request(input.origin+"/service-api/me/retirement",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({withdrawalId:input.withdrawalId})}));assert.equal(none.status,401);
  }
  assert.equal(retireCalls,fresh?1:0);
  if(mode==="--retry-only")assert.equal(receiptCalls,0);
  process.stdout.write(JSON.stringify({status:"PASS",beforeUserStatus:fresh?200:undefined,firstRetirementStatus:fresh?200:undefined,afterUserStatus:authStatus,lostResponseRetryStatus:expected,
   retryError:expected===401?"AUTH_REQUIRED":undefined,handlerAuthCalls:authCalls,retirementRpcCalls:retireCalls,receiptGetCalls:receiptCalls,retryMutationCalls:0,negativeChecks:negatives,readOnlyObservation:!fresh}));
 }
 }
}finally{globalThis.fetch=native;}
