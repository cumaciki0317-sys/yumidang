import {test}from 'node:test';
import assert from 'node:assert/strict';
import {createAiReportEvidenceHandling,recordAiResultAvailable}from '../../../backend/supabase/functions/_shared/db/ai-feedback-client.ts';
const id='11111111-1111-4111-8111-111111111111';
test('신고 준비 확인은 exact 서버 계약과 명시적인 true만 인정한다',async()=>{
 for(const value of [null,{contractVersion:'old',helpfulReady:true,reportReady:true},{contractVersion:'2026-10-05',helpfulReady:true,reportReady:'true'},{contractVersion:'2026-10-05',helpfulReady:true,reportReady:true,approved:true}]) {
  const db={rpc:async()=>value};await assert.rejects(createAiReportEvidenceHandling(db as never).isReady());
 }
 assert.equal(await createAiReportEvidenceHandling({rpc:async()=>({contractVersion:'2026-10-05',helpfulReady:true,reportReady:false})}).isReady(),false);
});
test('결과 증거는 원 scope만 보내며 다른 요청 응답을 성공으로 사용하지 않는다',async()=>{
 const scope={userId:id,requestId:id,leaseToken:id};let input:unknown;
 await recordAiResultAvailable({rpc:async(name,args)=>{input={name,args};return{requestId:id,availableAt:'2026-10-08T00:00:00Z'};}},scope);
 assert.deepEqual(input,{name:'record_ai_chat_result_available',args:{p_user_id:id,p_request_id:id,p_lease_token:id}});
 await assert.rejects(recordAiResultAvailable({rpc:async()=>({requestId:'other',availableAt:'2026-10-08T00:00:00Z'})},scope));
});
