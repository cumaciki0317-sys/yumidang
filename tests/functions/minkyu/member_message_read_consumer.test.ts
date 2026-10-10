import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ServiceApiClient} from '../../../apps/mobile/src/api.ts';
import {MemberService} from '../../../apps/mobile/src/member-service.ts';
import {dispatchVisibleMessages} from '../../../apps/mobile/src/chat-read-state.ts';
const room='11111111-1111-4111-8111-111111111111',seen='22222222-2222-4222-8222-222222222222',unseen='33333333-3333-4333-8333-333333333333';
function fixture(reply:unknown,status=200){const calls:any[]=[];const api=new ServiceApiClient('https://service.example.invalid/functions/v1/service-api',async()=> 'synthetic-bearer',async(url,init)=>{calls.push({url:String(url),body:JSON.parse(String(init?.body)),headers:new Headers(init?.headers)});return Response.json({data:reply,error:null,meta:{requestId:'synthetic'}},{status});});return {service:new MemberService(api),calls};}
test('화면이 본 한 메시지만 개별 집합 endpoint로 보내며 watermark와 과거 메시지를 바꾸지 않는다',async()=>{
 const f=fixture({messageIds:[seen],unreadCount:1});
 const receipt=await dispatchVisibleMessages({markVisible:(id,ids,signal)=>f.service.markMessagesRead(id,ids,signal)},room,[seen],new AbortController().signal);
 assert.deepEqual(receipt,{confirmedMessageIds:[seen],unreadCount:1});assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].url,`https://service.example.invalid/functions/v1/service-api/conversations/${room}/read/messages`);assert.deepEqual(f.calls[0].body,{messageIds:[seen]});assert.equal(f.calls[0].headers.get('authorization'),'Bearer synthetic-bearer');assert.equal(JSON.stringify(f.calls[0].body).includes(unseen),false);
});
test('서버 정렬 순서는 허용하되 다른 메시지·부분 집합·중복·추가 원문 응답은 거절한다',async()=>{
 const valid=fixture({messageIds:[unseen,seen],unreadCount:0});assert.deepEqual((await valid.service.markMessagesRead(room,[seen,unseen])).confirmedMessageIds,[unseen,seen]);
 for(const reply of [{messageIds:[unseen],unreadCount:0},{messageIds:[],unreadCount:0},{messageIds:[seen,seen],unreadCount:0},{messageIds:[seen],unreadCount:-1},{messageIds:[seen],unreadCount:0,content:'본문'}])await assert.rejects(fixture(reply).service.markMessagesRead(room,[seen]));
});
test('빈 집합·중복·101개·잘못된 ID와 중단은 네트워크 전에 거절한다',async()=>{
 const f=fixture({messageIds:[seen],unreadCount:0});for(const ids of [[],[seen,seen],Array(101).fill(seen),['bad']])await assert.rejects(f.service.markMessagesRead(room,ids));
 const c=new AbortController();c.abort();await assert.rejects(f.service.markMessagesRead(room,[seen],c.signal));assert.equal(f.calls.length,0);
});
test('개별 읽음 실패 뒤 watermark 호출이나 성공 backfill을 하지 않는다',async()=>{
 const f=fixture({messageIds:[unseen],unreadCount:0});await assert.rejects(dispatchVisibleMessages({markVisible:(id,ids,signal)=>f.service.markMessagesRead(id,ids,signal)},room,[seen],new AbortController().signal));assert.equal(f.calls.length,1);assert.ok(f.calls[0].url.endsWith('/read/messages'));
});
