import assert from 'node:assert/strict';
import test from 'node:test';
import {ServiceApiClient} from '../../apps/mobile/src/api.ts';
import {MemberService,change} from '../../apps/mobile/src/member-service.ts';
import {YumidangService} from '../../apps/mobile/src/service.ts';
const id='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222', ticket='33333333-3333-4333-8333-333333333333';
const start='2026-10-25T03:00:00Z', end='2026-10-25T04:00:00Z';
const manual={title:'취미 합주',placeName:'문화센터',publicAddress:'',publicAddressConfirmed:false};
const input={title:'함께 공연 가요',description:'공개 소개',category:'공연',startsAt:start,endsAt:end,recruitmentEndsAt:start,publicArea:'서울특별시 종로구 종로1가',registeredPlaceName:null,registeredAddress:'공개 주소',meetingDetail:'로비 앞',preferenceNote:null,tags:[],costType:'free',amount:0,manualEvent:manual};
function setup(reply,initial='synthetic',options={},sessionIdentity) {
  const calls=[]; let token=initial;
  const fetcher=async(url,options)=>{const body=options.body?JSON.parse(options.body):undefined;calls.push({url,options,body});const value=await reply(url,body,options,calls.length);return value instanceof Response?value:Response.json({data:value});};
  const client=new ServiceApiClient('https://synthetic.example/service-api',async()=>token,fetcher,sessionIdentity);
  return {calls,client,member:new MemberService(client,options),public:new YumidangService({serviceApiUrl:'https://synthetic.example/service-api',accessToken:async()=>token,fetcher}),setToken:v=>{token=v;}};
}
const allow=body=>({decision:'allow',reasons:[],ticketId:ticket,operationId:body.operationId,action:body.rpc==='create_service_post'?'post_create':'post_update',targetId:body.input.p_post_id});
test('manual create binds exactly inspected RPC input to save and two restricted headers',async()=>{
 const h=setup((url,b)=>url.endsWith('content-inspections')?allow(b):{postId:id,alreadyCreated:false});
 await h.member.create(id,input);
 assert.deepEqual(h.calls[0].body,{rpc:'create_service_post',operationId:id,input:{p_post_id:id,p_input:input}});
 assert.deepEqual(h.calls[1].body,{...input,postId:id});
 assert.equal(h.calls[1].options.headers['x-content-inspection-ticket'],ticket);
 assert.equal(h.calls[1].options.headers['x-content-operation-id'],id);
});
test('lost save response reuses same ticket/id without reinspection',async()=>{
 let writes=0;const h=setup((url,b)=>{if(url.endsWith('content-inspections'))return allow(b);if(++writes===1)throw Error('lost');return {postId:id,alreadyCreated:true};});
 await assert.rejects(h.member.create(id,input));await h.member.create(id,input);
 assert.equal(h.calls.length,3);assert.deepEqual(h.calls[1].options.headers,h.calls[2].options.headers);
});
test('same operation with altered payload cannot reuse approved ticket',async()=>{
 const h=setup((url,b)=>url.endsWith('content-inspections')?allow(b):{postId:id,alreadyCreated:false});await h.member.create(id,input);
 await assert.rejects(h.member.create(id,{...input,description:'changed'}),{code:'STATE_CONFLICT'});assert.equal(h.calls.length,2);
});
test('block never saves and cannot become public confirmation override',async()=>{
 const h=setup((url,b)=>({...allow(b),decision:'block',reasons:['PERSONAL_DATA'],ticketId:ticket}));
 await assert.rejects(h.member.create(id,input),{code:'CONTENT_BLOCKED'});assert.equal(h.calls.length,1);
 const invalid=setup((url,b)=>({...allow(b),decision:'confirm_required',reasons:['AMBIGUOUS_RISK']}));
 await assert.rejects(invalid.member.create(id,input),{code:'INVALID_SERVICE_RESPONSE'});assert.equal(invalid.calls.length,1);
});
test('missing inspection cannot fall back to uninspected manual save',async()=>{
 const h=setup(()=>Response.json({error:{code:'RESOURCE_NOT_FOUND'}},{status:404}));
 await assert.rejects(h.member.create(id,input),{code:'CONTENT_INSPECTION_UNAVAILABLE'});assert.equal(h.calls.length,1);
});
test('different account during inspection prevents save',async()=>{
 let h;h=setup((url,b)=>{h.setToken('other-account');return allow(b);});
 await assert.rejects(h.member.create(id,input),{code:'AUTH_REQUIRED'});assert.equal(h.calls.length,1);
});
test('cancelled late inspection never saves',async()=>{
 const c=new AbortController();const h=setup((url,b)=>{c.abort();return allow(b);});
 await assert.rejects(h.member.create(id,input,c.signal),{code:'CANCELLED'});assert.equal(h.calls.length,1);
});
test('manual edit binds operation, version and omission semantics exactly',async()=>{
 const h=setup((url,b)=>url.endsWith('content-inspections')?allow(b):{postId:id,status:'recruiting',updatedAt:start});
 await h.member.update(id,input,start,undefined,other);
 assert.equal(h.calls[0].body.input.p_expected_updated_at,start);assert.equal(h.calls[0].body.operationId,other);
 assert.equal(Object.hasOwn(h.calls[1].body,'eventId'),false);
 await assert.rejects(h.member.update(id,input,start),{code:'INSPECTION_OPERATION_REQUIRED'});
});
test('legacy source create and ordinary edit do not introduce mandatory preinspection',async()=>{
 const h=setup((url)=>url.endsWith('update')?{postId:id,status:'recruiting',updatedAt:start}:{postId:id,alreadyCreated:false});
 const {manualEvent,...plain}=input;await h.member.create(id,{...plain,eventId:other});await h.member.update(id,{...plain,eventId:null,manualEvent:null},start);
 assert.equal(h.calls.length,2);assert.equal(h.calls[1].body.eventId,null);assert.equal(h.calls[1].body.manualEvent,null);
});
test('enabled inspection requires tickets for ordinary/source writes and manual removal',async()=>{
 const h=setup((url,b,options)=>{
   if(url.endsWith('content-inspections'))return allow(b);
   assert.equal(options.headers['x-content-inspection-ticket'],ticket);
   return url.endsWith('update')?{postId:id,status:'recruiting',updatedAt:start}:{postId:id,alreadyCreated:false};
 },'synthetic',{postInspectionRequired:true});
 const {manualEvent,...plain}=input;
 await h.member.create(id,{...plain,eventId:other});
 await h.member.update(id,{...plain,eventId:null,manualEvent:null},start,undefined,other);
 assert.equal(h.calls.length,4);assert.equal(h.calls[2].body.input.p_input.manualEvent,null);
 await assert.rejects(h.member.update(id,plain,start),{code:'INSPECTION_OPERATION_REQUIRED'});
 const unavailable=setup(()=>Response.json({error:{code:'SERVICE_UNAVAILABLE'}},{status:503}),'synthetic',{postInspectionRequired:true});
 await assert.rejects(unavailable.member.create(id,plain),{code:'CONTENT_INSPECTION_UNAVAILABLE'});assert.equal(unavailable.calls.length,1);
});
test('trusted session epoch preserves lost-save ticket through token refresh',async()=>{
 let epoch=1,writes=0;const h=setup((url,b)=>{if(url.endsWith('content-inspections'))return allow(b);if(++writes===1)throw Error('lost');return {postId:id,alreadyCreated:true};},'old-token',{},()=>epoch);
 await assert.rejects(h.member.create(id,input));h.setToken('refreshed-token');await h.member.create(id,input);
 assert.equal(h.calls.length,3);assert.equal(h.calls[2].options.headers.Authorization,'Bearer refreshed-token');
 assert.equal(h.calls[1].options.headers['x-content-inspection-ticket'],h.calls[2].options.headers['x-content-inspection-ticket']);
 epoch++;await h.member.create(id,input);assert.equal(h.calls.length,5);
});
test('logout and re-entry with even the same token invalidates pending inspection',async()=>{
 let epoch=1;const h=setup((url,b)=>{epoch++;return allow(b);},'same-token',{},()=>epoch);
 await assert.rejects(h.member.create(id,input),{code:'AUTH_REQUIRED'});assert.equal(h.calls.length,1);
});
test('account change while initially acquiring token sends no request',async()=>{
 let epoch=1,release,calls=0;
 const pending=new Promise(resolve=>{release=resolve;});
 const client=new ServiceApiClient('https://synthetic.example/service-api',()=>pending,async()=>{calls++;throw Error('unexpected');},()=>epoch);
 const attempt=new MemberService(client).create(id,input);
 epoch++;release('new-account-token');
 await assert.rejects(attempt,{code:'AUTH_REQUIRED'});assert.equal(calls,0);
});
test('event relation decoder enforces state privacy and exact source/manual exclusivity',async()=>{
 for(const row of [{postId:id,eventId:other,manualEvent:null,linkedEvent:null,eventLinkState:'hidden'},{postId:id,eventId:null,manualEvent:manual,linkedEvent:null,eventLinkState:'manual'},{postId:id,eventId:null,manualEvent:null,linkedEvent:null,eventLinkState:'none'}]) assert.deepEqual(await setup(()=>row,null).public.getPostEventLink(id),row);
 for(const patch of [{eventLinkState:'linked'},{manualEvent:manual},{privateDetails:{secret:'x'}}]) {
  const row={postId:id,eventId:other,manualEvent:null,linkedEvent:null,eventLinkState:'hidden',...patch};await assert.rejects(setup(()=>row,null).public.getPostEventLink(id),{code:'INVALID_SERVICE_RESPONSE'});
 }
});
test('event-filter request uses exact id and paging; unsupported server is not empty list',async()=>{
 const h=setup(()=>({status:'no_results',posts:[],nextCursor:null}),null);
 await h.public.searchEventPosts(id,true,'abc');const u=new URL(h.calls[0].url);
 assert.equal(u.searchParams.get('eventId'),id);assert.equal(u.searchParams.get('availability'),'recruiting');assert.equal(u.searchParams.get('sort'),'created_desc');assert.equal(u.searchParams.get('limit'),'10');assert.equal(u.searchParams.get('cursor'),'abc');
 const bad=setup(()=>Response.json({error:{code:'INVALID_REQUEST'}},{status:400}),null);await assert.rejects(bad.public.searchEventPosts(id),{code:'INVALID_REQUEST'});assert.equal(bad.calls.length,1);
});
const baseChange={appointmentId:id,changeId:other,conditionVersion:'v1',status:'awaiting_response',oldSchedule:{startsAt:start,endsAt:end},newSchedule:{startsAt:start,endsAt:end},requestedByMe:false,requestedAt:start,expiresAt:end,resolvedAt:null};
const proposal={...baseChange,changeKind:'event',eventFingerprint:'a'.repeat(64),newEventInput:{eventId:null,manualEvent:manual},newLinkedEvent:null};
test('event proposal discrimination rejects unknown or incomplete event kinds',()=>{
 assert.equal(change(proposal).changeKind,'event');assert.equal(change(baseChange).changeKind,undefined);
 for(const p of [{...proposal,changeKind:'future'},{...proposal,eventFingerprint:'bad'},{...baseChange,newEventInput:proposal.newEventInput},{...proposal,status:'accepted'}])assert.throws(()=>change(p));
 assert.equal(change({...proposal,status:'accepted',resolvedAt:end,newEventInput:null,newLinkedEvent:null}).status,'accepted');
});
test('event accept uses dedicated fingerprint endpoint with terminal content cleared',async()=>{
 const h=setup(()=>({...proposal,status:'accepted',resolvedAt:end,newEventInput:null,newLinkedEvent:null}));
 await h.member.acceptEventChange(id,other,'v1','a'.repeat(64));assert.ok(h.calls[0].url.endsWith('/accept-event'));assert.deepEqual(h.calls[0].body,{changeId:other,conditionVersion:'v1',eventFingerprint:'a'.repeat(64)});
});
test('manual confirmation conditions remain readable with strict extra field checking',async()=>{
 const {registeredPlaceName,registeredAddress,meetingDetail,recruitmentEndsAt,...rest}=input;
 const conditions={...rest,postId:id,paymentDirection:'none'};
 const h=setup(()=>({requestId:id,conditionVersion:'v1',status:'awaiting_consent',conditions,expiresAt:end}));
 assert.deepEqual((await h.member.consent(id)).conditions.manualEvent,manual);
});
test('inspection headers cannot be injected on arbitrary paths or GET requests',async()=>{
 const h=setup(()=>null);for(const [path,method] of [['/me','POST'],['/posts','GET']])await assert.rejects(h.client.request(path,{method,inspection:{ticketId:ticket,operationId:id}}),{code:'INVALID_REQUEST'});assert.equal(h.calls.length,0);
});
