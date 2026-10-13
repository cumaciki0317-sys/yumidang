/* Canonical synthetic browse fields plus explicitly approved, deterministic preview
   qualifications/deadlines/introduction. No backend data or real-person claims. */
(function(root){
'use strict';
const samples={
 4:{qualification:'성인 전체',introduction:'연남동 카페에서 각자 가져온 책을 읽고 잠깐 감상을 나누는 동행 예시입니다.'},
 1:{qualification:'성인 전체',introduction:'삼청동 미술관에서 각자의 속도로 작품을 둘러보고 싶어요. 마음에 남는 작품이 있으면 편하게 감상을 나눠요. 전시를 자주 보지 않는 분도 좋아요.'},
 2:{qualification:'성인 전체',introduction:'가을 분위기를 느끼며 축제를 구경하고 한강공원을 가볍게 산책해요. 중간중간 쉬면서 편안하게 이야기 나눌 분을 기다려요.'},
 3:{qualification:'성인 전체',introduction:'성수동에서 브런치를 먹으며 소소한 이야기를 나누고 싶어요. 메뉴는 만나서 서로의 취향에 맞춰 고르고, 부담 없이 여유로운 시간을 보내요.'}
};
function listingFixture(r,mask){
 const sample=samples[r.id]||{qualification:'',introduction:''};
 const startsAt=new Date(r.date+'T'+r.start+':00+09:00').toISOString();
 const format=n=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',weekday:'short'}).format(n)+' '+new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false}).format(n);
 const reviewClock='2026-10-08T00:00:00.000Z';
 const deadline=format(Date.parse(startsAt));
 const day=Number(r.date.slice(5,7))+'월 '+Number(r.date.slice(8))+'일 ('+r.weekday+')';
 return {title:r.title,category:r.category,name:r.fullName,masked:mask(r.fullName),age:r.age,sweetness:r.score,publicArea:r.region+' '+r.area,schedule:day+' '+r.start+' – '+r.end,deadline,startsAt,reviewClock,endsAt:new Date(r.date+'T'+r.end+':00+09:00').toISOString(),place:r.place,address:r.address,meeting:'',qualification:sample.qualification,introduction:sample.introduction,wishes:'',listingClosed:r.state==='closed',hasEvent:!!r.event,eventTitle:r.event,eventDates:'',requestExpires:format(Math.min(Date.parse(reviewClock)+21600000,Date.parse(startsAt)))};
}
root.YumidangListingMap={listingFixture};if(typeof module!=='undefined')module.exports={listingFixture};
})(typeof globalThis!=='undefined'?globalThis:this);
