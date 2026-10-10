import {test} from 'node:test';
import assert from 'node:assert/strict';
import {contentInspectionInput,createContentInspection,type ContentTicketIssuer,type ContentClassifier} from '../../../backend/supabase/functions/_shared/services/content-inspection.ts';
import {toPublicError} from '../../../backend/supabase/functions/_shared/http/errors.ts';
const user='11111111-1111-4111-8111-111111111111',target='22222222-2222-4222-8222-222222222222',op='33333333-3333-4333-8333-333333333333',ticket='44444444-4444-4444-8444-444444444444';
const ready={approved:true as const,decisionId:'reviewed-test',policyVersion:'test-1',scannerVersion:'synthetic-1'};
const args={p_request_id:target,p_message_id:op,p_content:'정상 약속 안내'};
const signal=()=>new AbortController().signal;
const reply=(input:Parameters<ContentTicketIssuer['issue']>[0])=>({ticketId:ticket,userId:input.userId,operationId:input.operationId,action:input.action,targetId:input.targetId});
test('본문 검사는 등록 주소·상세 지점·사진·ID를 제외하며 정확한 전체 저장 입력은 결합한다',()=>{
 const post={p_post_id:target,p_input:{title:'제목',description:'본문',preferenceNote:null,publicArea:'합성 공개 지역',registeredPlaceName:'합성 공공 장소',tags:['산책'],registeredAddress:'합성 주소',meetingDetail:'합성 상세 지점'}};
 const cases:[string,any,string[]][]=[
 ['create_service_post',post,['제목','본문','합성 공개 지역','합성 공공 장소','산책']],['update_service_post',{...post,p_expected_updated_at:'2026-10-09T00:00:00Z'},['제목','본문','합성 공개 지역','합성 공공 장소','산책']],
 ['set_my_profile_preferences',{p_interests:['독서'],p_conversation_styles:['차분한 대화'],p_mbti:'INFP',p_bio:'소개'},['소개','독서','차분한 대화']],
 ['set_my_profile_traits',{p_interests:['독서'],p_conversation_styles:['대화'],p_mbti:null},['독서','대화']],
 ['complete_naver_signup',{p_avatar_path:'합성 사진 경로',p_interests:['독서'],p_conversation_styles:[],p_mbti:null},['독서']],
 ['submit_appointment_review',{p_appointment_id:target,p_rating:5,p_comment:'후기',p_experience:'good',p_praises:[]},['후기']],
 ['request_service_post',{p_post_id:target,p_message_id:op,p_message:'첫 메시지'},['첫 메시지']],['send_conversation_message',args,['정상 약속 안내']],
 ];
 for(const [name,input,expected] of cases){const v=contentInspectionInput(name,input,user,op);assert.deepEqual(v.inspection.fields.map(f=>f.text),expected);assert.deepEqual(v.scope.input,input);assert.ok(Object.isFrozen(v.scope.input));}
});
test('다른 메시지 ID·추가 필드·미지원 RPC는 분류 전에 거절한다',()=>{
 for(const input of [{...args,p_message_id:target},{...args,confirmed:true}])assert.throws(()=>contentInspectionInput('send_conversation_message',input as never,user,op));
 assert.throws(()=>contentInspectionInput('unknown',args,user,op));
});
test('승인되지 않은 분류기·버전은 호출·ticket 발급을 시작하지 않는다',async()=>{
 let calls=0;const classifier={inspect:async()=>{calls++;return {decision:'allow' as const,reasons:[]};}},issuer={issue:async(input:any)=>{calls++;return reply(input);}};
 for(const value of [undefined,{...ready,approved:false},{...ready,policyVersion:''}]){const port=createContentInspection(value as never,classifier,issuer);await assert.rejects(port.inspect('send_conversation_message',args,user,op,signal()));}
 assert.equal(calls,0);
});
test('검사 중 원본 객체가 바뀌어도 ticket에는 검사한 정확한 입력만 결합한다',async()=>{
 const input={...args};let captured:any;
 const port=createContentInspection(ready,{inspect:async v=>{assert.equal(v.fields[0].text,args.p_content);input.p_content='바뀐 입력';return{decision:'allow',reasons:[]};}},
 {issue:async v=>{captured=v;return reply(v);}});
 assert.deepEqual(await port.inspect('send_conversation_message',input,user,op,signal()),{decision:'allow',reasons:[],ticketId:ticket});
 assert.equal(captured.input.p_content,args.p_content);assert.equal(captured.userId,user);assert.equal(captured.operationId,op);
});
test('애매한 채팅과 명확 고위험은 별도 판정이고 사용자 확인값으로 차단을 해제하지 않는다',async()=>{
 for(const [decision,reason] of [['confirm_required','AMBIGUOUS_RISK'],['block','HIGH_RISK']] as const){
  let issued:any;const port=createContentInspection(ready,{inspect:async()=>({decision,reasons:[reason]})},{issue:async v=>{issued=v;return reply(v);}});
  assert.equal((await port.inspect('send_conversation_message',args,user,op,signal())).decision,decision);assert.equal(issued.decision,decision);
 }
});
test('틀린 판정·원문 이유·공개 콘텐츠 확인 우회는 ticket을 발급하지 않는다',async()=>{
 let issued=0;const issuer={issue:async(v:any)=>{issued++;return reply(v);}};
 for(const value of [{decision:'allow',reasons:['HIGH_RISK']},{decision:'block',reasons:[]},{decision:'block',reasons:['원문 이유']},{decision:'confirm_required',reasons:['HIGH_RISK']},{decision:'allow',reasons:[],rawText:'원문'}]){
  const port=createContentInspection(ready,{inspect:async()=>value as never},issuer);await assert.rejects(port.inspect('send_conversation_message',args,user,op,signal()));
 }
 const publicPort=createContentInspection(ready,{inspect:async()=>({decision:'confirm_required',reasons:['AMBIGUOUS_RISK']})},issuer);
 await assert.rejects(publicPort.inspect('set_my_profile_traits',{p_interests:[],p_conversation_styles:[],p_mbti:null},user,op,signal()));assert.equal(issued,0);
});
test('다른 사용자·대상·작업·요청으로 돌아온 ticket은 사용하지 않는다',async()=>{
 for(const change of [{userId:target},{targetId:user},{operationId:target},{action:'review'},{ticketId:'bad'}]){
  const port=createContentInspection(ready,{inspect:async()=>({decision:'allow',reasons:[]})},{issue:async v=>({...reply(v),...change}) as never});
  await assert.rejects(port.inspect('send_conversation_message',args,user,op,signal()));
 }
});
test('중단을 무시하는 분류기의 늦은 응답도 발급을 시작하지 않는다',async()=>{
 let resolve!:(v:any)=>void,entered!:()=>void,issued=0;const waiting=new Promise<void>(r=>entered=r),pending=new Promise<any>(r=>resolve=r),controller=new AbortController();
 const port=createContentInspection(ready,{inspect:async()=>{entered();return pending;}},{issue:async v=>{issued++;return reply(v);}});
 const running=port.inspect('send_conversation_message',args,user,op,controller.signal);await waiting;controller.abort();await assert.rejects(running);
 resolve({decision:'allow',reasons:[]});await new Promise(r=>setImmediate(r));assert.equal(issued,0);
});
test('발급 응답 유실은 자동 재발급·새 요청 키·성공으로 바꾸지 않고 오류 원문을 숨긴다',async()=>{
 let issued=0;const port=createContentInspection(ready,{inspect:async()=>({decision:'allow',reasons:[]})},{issue:async()=>{issued++;throw new Error('private source');}});
 try{await port.inspect('send_conversation_message',args,user,op,signal());assert.fail();}catch(e){const v=toPublicError(e);assert.equal(v.error.code,'EXTERNAL_UNAVAILABLE');assert.equal(JSON.stringify(v).includes('private source'),false);}
 assert.equal(issued,1);
});
