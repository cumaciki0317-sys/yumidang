/** Local exported Expo screen journeys. Synthetic auth/HTTP only; never real DB/member/provider evidence. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const preview=process.env.FOLLOWUP_PREVIEW_ROOT;
if(!preview)throw Error('PREVIEW_ROOT_REQUIRED');
const base=process.env.PREVIEW_URL||'http://127.0.0.1:8099';
if(new URL(base).hostname!=='127.0.0.1')throw Error('LOCAL_ONLY');
const root=path.resolve(import.meta.dirname,'../../..'),hashes={};
for(const source of ['apps/mobile/src/screens/BrowseScreens.tsx','apps/mobile/src/screens/RemoteMemberScreens.tsx','apps/mobile/src/screens/RemoteScreens.tsx','apps/mobile/src/member-service.ts']){
 const a=await readFile(path.join(root,source)),b=await readFile(path.join(preview,source));assert.deepEqual(a,b);hashes[source]=createHash('sha256').update(a).digest('hex');
}
const {chromium}=createRequire(path.join(preview,'apps/mobile/package.json'))('playwright');
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
const page=await browser.newPage({viewport:{width:390,height:844}});
const uid='11111111-1111-4111-8111-111111111111',rid='22222222-2222-4222-8222-222222222222',aid='33333333-3333-4333-8333-333333333333',eid='44444444-4444-4444-8444-444444444444';
const api='https://api.example.test',now='2026-10-08T01:00:00Z';
let requestStatus='pending',started=false,eventCancelled=false,missingClock=false,declineFailures=1;
const calls=[],checks=[],errors=[],unexpected=[];
const output=path.join(preview,'independent-evidence');await mkdir(output,{recursive:true});
const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);};
const event=()=>({id:eid,provider:'kopis',sourceId:'synthetic-event',sourceStatus:eventCancelled?'cancelled':'active',title:'합성 전시 행사',category:'전시',region:'서울특별시',placeName:'합성 행사장',publicAddress:'서울특별시 성동구 성수동',admission:{kind:'free'},sourceUrl:null,collectedAt:now,state:'upcoming',precision:'date',startsOn:'2026-10-09',endsOn:'2026-10-11'});
const appointment=()=>({appointment_id:aid,post_title:'합성 확정 약속',status:'confirmed',post_starts_at:started?'2026-10-08T00:00:00Z':'2026-10-09T00:00:00Z',post_ends_at:'2026-10-09T05:00:00Z',post_public_area:'서울특별시 성동구 성수동',counterpart_masked_name:'합*인',can_confirm_completion:false,...(missingClock?{}:{server_now:now})});
const conversation=()=>({request_id:rid,post_title:'합성 작성자 대화',my_role:'author',can_send:requestStatus==='pending',request_status:requestStatus,post_id:null,counterpart_masked_name:'합*인',last_message:'합성 첫 메시지',last_read_message_id:null,read_at:null,unread_count:1});
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',async route=>{
 const request=route.request(),u=new URL(request.url());if(u.origin===base)return route.continue();if(u.origin!==api){unexpected.push(u.origin);return route.abort();}
 const pathname=u.pathname.replace('/functions/v1/service-api',''),body=request.postData()?JSON.parse(request.postData()):null;
 calls.push({pathname,method:request.method(),body,auth:request.headers().authorization==='Bearer browser-synthetic-member'});let data,status=200;
 if(pathname==='/me')data={userId:uid,realName:'합성 종현',avatarUrl:null,bio:null,sweetness:15};
 else if(pathname==='/appointments')data=[appointment()];
 else if(pathname===`/appointments/${aid}`)data=[appointment()];
 else if(pathname===`/appointments/${aid}/schedule-change`)data={appointmentId:aid,status:'confirmed',startsAt:appointment().post_starts_at,endsAt:appointment().post_ends_at,updatedAt:now,change:null,cancellation:null};
 else if(pathname==='/conversations')data=[conversation()];
 else if(pathname===`/conversations/${rid}`)data=[conversation()];
 else if(pathname===`/conversations/${rid}/messages`)data={items:[],nextCursor:null};
 else if(pathname===`/requests/${rid}/consent`)data={consent:null};
 else if(pathname===`/requests/${rid}/decline`){assert.deepEqual(body,{});if(declineFailures-->0){status=503;data=null;}else{requestStatus='declined';data=[{id:rid,status:'declined'}];}}
 else if(pathname==='/events')data={events:[event()],nextCursor:null};
 else if(pathname===`/events/${eid}`)data=event();
 else if(pathname==='/me/posts'||pathname==='/notifications')data={items:[],nextCursor:null};
 else if(pathname==='/requests/sent'||pathname==='/requests/received')data=[];
 else if(pathname===`/profiles/${uid}`)data={profileId:uid,displayName:'합성 공개 프로필',age:25,gender:'female',avatarPath:null,bio:null,interests:[],conversationStyles:[],mbti:null,completedCount:0,sweetness:15};
 else if(pathname===`/profiles/${uid}/reviews`)data={reviews:[],praisesTop5:[],nextCursor:null,completedCount:0};
 else if(pathname===`/profiles/${uid}/review-summary`)data={summary:null};
 else{unexpected.push(pathname);return route.abort();}
 return route.fulfill({status,contentType:'application/json',body:JSON.stringify(status===200?{data,requestId:uid}:{error:{code:'DEPENDENCY_UNAVAILABLE',message:'synthetic failure'},requestId:uid})});
});
const install=async target=>{await page.goto(`${base}/test-session?target=${encodeURIComponent(target)}`);await page.getByRole('button',{name:'Install synthetic session',exact:true}).click();};
try{
 await install('/');await page.getByText('합성 종현',{exact:true}).waitFor();await page.getByText('합성 확정 약속',{exact:true}).waitFor();
 check('home consumes member name and confirmed appointment',calls.some(c=>c.pathname==='/me')&&calls.some(c=>c.pathname==='/appointments'));
 check('home renders public region and D-day',await page.getByText('서울특별시 성동구 성수동',{exact:true}).count()>0&&/D-1/.test(await page.locator('body').innerText()));
 await page.screenshot({path:path.join(output,'home.png')});
 await page.getByRole('button',{name:'알림',exact:true}).click();await page.waitForURL(/notifications/);check('home notifications navigation works',true);
 await install('/chats');await page.getByText('신청 대기',{exact:true}).waitFor();check('chat list shows server request status',true);
 await install(`/chat?id=request:${rid}`);await page.getByRole('button',{name:'신청 거절',exact:true}).click();await page.getByText('거절 후 상대는 이 공고에 다시 신청할 수 없어요.',{exact:true}).waitFor();
 check('decline requires confirmation before mutation',!calls.some(c=>c.pathname.endsWith('/decline')));
 await page.getByRole('button',{name:'계속 대화하기',exact:true}).click();check('dismiss decline sends zero',!calls.some(c=>c.pathname.endsWith('/decline')));
 await page.getByRole('button',{name:'신청 거절',exact:true}).click();await page.getByRole('button',{name:'확인',exact:true}).click();await page.waitForTimeout(400);
 check('failed decline stays in room and never auto repeats',new URL(page.url()).pathname==='/chat'&&calls.filter(c=>c.pathname.endsWith('/decline')).length===1);
 await page.getByRole('button',{name:'확인',exact:true}).click();await page.waitForURL(/chats/);await page.getByText('거절',{exact:true}).waitFor();check('explicit decline retry updates server status',calls.filter(c=>c.pathname.endsWith('/decline')).length===2);
 await install('/me');await page.getByRole('button',{name:'내 공개 프로필·후기 보기',exact:true}).click();await page.getByText('합성 공개 프로필',{exact:true}).waitFor();check('own public profile route uses verified user ID',new URL(page.url()).searchParams.get('id')===uid);
 await install(`/event?id=${eid}`);await page.getByRole('button',{name:'이 행사로 동행 모집하기',exact:true}).click();await page.waitForURL(/create/);await page.getByText('합성 전시 행사',{exact:true}).last().waitFor();
 check('event detail opens drafting with connected event',new URL(page.url()).searchParams.get('id')===`event:${eid}`);
 await page.getByRole('button',{name:'행사장을 장소 후보로 찾기',exact:true}).click();check('event venue preloads place candidate query',await page.getByRole('textbox').evaluateAll(inputs=>inputs.some(input=>input.value==='합성 행사장')));
 await page.screenshot({path:path.join(output,'event-place.png')});
 eventCancelled=true;await install(`/event?id=${eid}`);await page.getByText('취소된 행사예요. 신규 동행에 연결할 수 없어요.',{exact:true}).waitFor();check('cancelled event has no new recruitment action',await page.getByRole('button',{name:'이 행사로 동행 모집하기',exact:true}).count()===0);eventCancelled=false;
 await install(`/cancel?id=appointment:${aid}`);await page.getByRole('button',{name:'약속 취소',exact:true}).waitFor();check('before-start confirmed appointment exposes cancellation',true);
 started=true;await install(`/cancel?id=appointment:${aid}`);await page.getByText(/시작 이후/).first().waitFor();check('started appointment has no unilateral cancel control',await page.getByRole('button',{name:'약속 취소',exact:true}).count()===0);await page.screenshot({path:path.join(output,'started-cancel.png')});
 missingClock=true;await install(`/cancel?id=appointment:${aid}`);await page.waitForTimeout(350);check('missing server clock cannot enable cancellation',await page.getByRole('button',{name:'약속 취소',exact:true}).count()===0);
 check('all member HTTP requests use synthetic authentication',calls.every(c=>c.auth));check('no unexpected external request or page error',unexpected.length===0&&errors.length===0);
}finally{await writeFile(path.join(output,'receipt.json'),JSON.stringify({checks,calls,errors,unexpected,hashes,evidence:'localhost exported Expo; synthetic auth/HTTP; no actual DB/member/device evidence'},null,2));await browser.close();}
process.stdout.write(JSON.stringify({status:'PASS',checks:checks.length,receipt:path.join(output,'receipt.json')})+'\n');
