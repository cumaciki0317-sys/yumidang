/** 최소 첨부/권한/멱등 접수 합성 검사. 실제 신고 DB·Storage·ACL·정리 검증이 아니다. */
import test from "node:test";
import assert from "node:assert/strict";
import {createRpcAiFeedback,readAiFeedbackInput} from "../../../backend/supabase/functions/_shared/ai/Agents/chatbot/feedback.ts";
import {createAiChatHandler} from "../../../backend/supabase/functions/ai-chat/handler.ts";
import {HttpError} from "../../../backend/supabase/functions/_shared/http/errors.ts";
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const userId=id(1), feedbackId=id(2), requestId=id(3);
const helpful={clientRequestId:"feedback-1",requestId,action:"helpful"};
const report={...helpful,action:"report",confirmed:true,attachment:{kind:"answer",text:"확인한 해당 답변 일부"}};
const handling={isReady:async()=>true};
const post=(body,path="/functions/v1/ai-chat/feedback")=>new Request("https://synthetic.invalid"+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
function harness({db,ready=handling,authenticate=async()=>({userId}),feedback}={}){
 const calls=[];
 const client=db??{rpc:async(name,args)=>{calls.push({name,args});return {status:"accepted",feedbackId,hideAnswer:args.p_action==="report"};}};
 const handler=createAiChatHandler({allowedOrigins:[],maxBodyBytes:12000,authenticate,engine:{status:"unavailable",code:"NOT_CONFIGURED"},
  feedback:feedback??createRpcAiFeedback(client,ready),requestGate:{acquire:async()=>assert.fail("AI 개인 차감 없음"),finish:async()=>assert.fail()},
  openSession:()=>assert.fail("성향/검색/모델 연결 없음")});
 return {handler,calls};
}
test("helpful은 인증 회원으로 최소 RPC만 호출하며 모델 미준비에도 원문 없이 접수한다",async()=>{
 const {handler,calls}=harness({ready:null});
 const res=await handler(post(helpful)),body=await res.json();
 assert.equal(res.status,200);assert.deepEqual(body.data,{status:"accepted",feedbackId,hideAnswer:false});
 assert.deepEqual(calls,[{name:"submit_ai_feedback",args:{p_user_id:userId,p_request_id:requestId,p_client_request_id:"feedback-1",p_action:"helpful",p_attachment:null,p_contract_version:"2026-10-05"}}]);
});
test("report는 제출 확인한 답변 하나 또는 업로드 asset 하나만 접수하고 해당 답변 숨김을 반환한다",async()=>{
 for(const attachment of [report.attachment,{kind:"capture",assetId:id(4)}]){
  const {handler,calls}=harness();const res=await handler(post({...report,attachment},"/ai-chat/feedback"));
  assert.equal(res.status,200);assert.deepEqual((await res.json()).data,{status:"accepted",feedbackId,hideAnswer:true});
  assert.deepEqual(calls[0].args.p_attachment,attachment);assert.equal(calls[0].args.p_user_id,userId);
  assert.equal(Object.hasOwn(calls[0].args,"messages"),false);assert.equal(Object.hasOwn(calls[0].args,"conversation"),false);
 }
});
test("신고 자료 소유권/ACL/접근기록/정리 포트 미연결·실패·false는 저장 없이 not_enabled다",async()=>{
 for(const ready of [null,{isReady:async()=>false},{isReady:async()=>"true"},{isReady:async()=>{throw new Error("PRIVATE_BODY");}}]){
  let calls=0;const feedback=createRpcAiFeedback({rpc:async()=>{calls++;assert.fail();}},ready);
  assert.deepEqual(await feedback.submit(userId,report),{status:"not_enabled",reason:"AI_REPORT_EVIDENCE_HANDLING_NOT_CONNECTED"});assert.equal(calls,0);
 }
});
test("누락·2개 첨부·미확인·본문 userId/전체 대화·외부 URL은 인증 뒤 400으로 차단한다",async()=>{
 const invalid=[{...helpful,userId:id(9)},{...report,messages:[{role:"user",content:"전체 대화 원문"}]},
  {...report,confirmed:false},{...report,confirmed:undefined},{...report,attachment:undefined},
  {...report,attachments:[report.attachment,{kind:"capture",assetId:id(4)}]},
  {...report,attachment:[report.attachment,{kind:"capture",assetId:id(4)}]},
  {...report,attachment:{...report.attachment,assetId:id(4)}},
  {...report,attachment:{kind:"capture",assetId:"https://private.invalid/full-capture"}},
  {...report,attachment:{kind:"answer",text:" "}},{...report,attachment:{kind:"answer",text:"가".repeat(501)}},
  {...helpful,attachment:report.attachment},{...helpful,requestId:"invalid"},
  {...helpful,clientRequestId:"x".repeat(129)}];
 for(const input of invalid){const {handler,calls}=harness();const res=await handler(post(input));assert.equal(res.status,400);assert.equal(calls.length,0);assert.equal(JSON.stringify(await res.json()).includes("전체 대화 원문"),false);}
 assert.equal(readAiFeedbackInput({...report,attachment:{kind:"answer",text:"😀".repeat(500)}}).attachment.text.length,1000,"기존 500자 한도를 Unicode 문자로 적용");
});
test("미인증은 본문·첨부·RPC 전에 401이며 전체 원문/오류 원문을 응답에 반사하지 않는다",async()=>{
 const {handler,calls}=harness({authenticate:async()=>{throw new HttpError("AUTH_REQUIRED");}});
 const res=await handler(post({...report,messages:"PRIVATE_CONVERSATION"}));assert.equal(res.status,401);assert.equal(calls.length,0);
 assert.equal(JSON.stringify(await res.json()).includes("PRIVATE_CONVERSATION"),false);
});
test("RPC 미지원과 응답 유실은 성공/숨김으로 표시하지 않으며 원문 오류를 제거한다",async()=>{
 for(const error of [new Error("PRIVATE_BODY RPC_NOT_FOUND"),new HttpError("ACCESS_DENIED")]){
  const {handler}=harness({db:{rpc:async()=>{throw error;}}});
  for(const input of [helpful,report]){const res=await handler(post(input));assert.equal(res.status,200);const body=await res.json();
   assert.deepEqual(body.data,{status:"not_enabled",reason:"AI_FEEDBACK_STORAGE_NOT_CONNECTED"});assert.equal(JSON.stringify(body).includes("PRIVATE_BODY"),false);assert.equal(Object.hasOwn(body.data,"hideAnswer"),false);}
 }
});
test("접수 소유권/asset 소유권/멱등키 충돌은 거절하고 잘못된 성공 UUID·숨김 플래그도 숨기지 않는다",async()=>{
 for(const [result,status] of [[{status:"request_not_owned"},403],[{status:"asset_not_owned"},403],[{status:"idempotency_conflict"},409],
  [{status:"accepted",feedbackId:"bad",hideAnswer:true},503],[{status:"accepted",feedbackId,hideAnswer:false},503],
  [{status:"accepted",feedbackId,hideAnswer:true,raw:"PRIVATE_BODY"},503]]){
  const {handler}=harness({db:{rpc:async()=>result}});const res=await handler(post(report));assert.equal(res.status,status);
  assert.equal(JSON.stringify(await res.json()).includes("PRIVATE_BODY"),false);
 }
});
test("같은 회원/클라이언트키/본문 재접수는 원자 DB 멱등 결과로 같은 접수 ID를 사용한다",async()=>{
 let writes=0;const stored=new Map();
 const db={rpc:async(_name,args)=>{
  const key=args.p_user_id+":"+args.p_client_request_id, fingerprint=JSON.stringify(args);const old=stored.get(key);
  if(old)return old.fingerprint===fingerprint?old.result:{status:"idempotency_conflict"};
  writes++;const result={status:"accepted",feedbackId,hideAnswer:args.p_action==="report"};stored.set(key,{fingerprint,result});return result;
 }};
 const {handler}=harness({db});const first=await handler(post(report)),second=await handler(post(report));
 assert.deepEqual((await first.json()).data,(await second.json()).data);assert.equal(writes,1,"가상 원자 DB만 증명하며 실제 동시성은 미실행");
 assert.equal((await handler(post({...report,attachment:{kind:"answer",text:"다른 자료"}}))).status,409);
});
test("전체 대화를 첨부하지 않고 사용자가 확인한 최소 자료만 DB로 보내며 로그가 없다",async()=>{
 const logs=[];const methods=["log","warn","error","info","debug"],saved=Object.fromEntries(methods.map(k=>[k,console[k]]));
 try{for(const k of methods)console[k]=(...args)=>logs.push(args);
  const {handler,calls}=harness();const res=await handler(post(report));assert.equal(res.status,200);
  assert.deepEqual(calls[0].args.p_attachment,report.attachment);assert.equal(JSON.stringify(calls).includes("messages"),false);
  assert.equal(logs.length,0);
 }finally{for(const k of methods)console[k]=saved[k];}
});
