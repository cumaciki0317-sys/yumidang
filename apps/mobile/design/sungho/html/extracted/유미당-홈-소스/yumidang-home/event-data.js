/* Fictional schedule data, with explicit Asia/Seoul offsets. No service/API connection. */
(()=>{
 const events=[
 {id:'sample-autumn',category:'축제',title:'함께 즐기는 가을 축제',where:'한강공원',dateLabel:'10.10(토)',startAt:'2026-10-10T10:00:00+09:00',endAt:'2026-10-10T21:00:00+09:00',timezone:'Asia/Seoul',sample:true},
 {id:'sample-jazz',category:'축제',title:'가을밤 재즈 페스티벌',where:'서울숲',dateLabel:'10.10(토)',startAt:'2026-10-10T18:00:00+09:00',endAt:'2026-10-10T22:00:00+09:00',timezone:'Asia/Seoul',sample:true},
 {id:'sample-lights',category:'축제',title:'반짝이는 빛 축제',where:'청계천',dateLabel:'10.11(일)',startAt:'2026-10-11T18:00:00+09:00',endAt:'2026-10-11T23:00:00+09:00',timezone:'Asia/Seoul',sample:true},
 {id:'sample-food',category:'축제',title:'함께 맛보는 푸드 축제',where:'문화광장',dateLabel:'10.11(일)',startAt:'2026-10-11T11:00:00+09:00',endAt:'2026-10-11T20:00:00+09:00',timezone:'Asia/Seoul',sample:true},
 {id:'sample-books',category:'축제',title:'책과 산책 페스티벌',where:'시민공원',dateLabel:'10.11(일)',startAt:'2026-10-11T10:00:00+09:00',endAt:'2026-10-11T18:00:00+09:00',timezone:'Asia/Seoul',sample:true}
 ].map(Object.freeze);
 // Explicit frozen event fixtures. No clock, date filtering, polling or service calls.
 window.YumidangEventData=Object.freeze({events:Object.freeze(events),reviewDate:'2026-10-08'});
 function render(){
  for(const item of events){const card=document.querySelector('[data-event-id="'+item.id+'"]');if(!card)continue;
   card.dataset.category=item.category;card.dataset.startAt=item.startAt;card.dataset.endAt=item.endAt;card.dataset.timezone=item.timezone;
   card.querySelector('.event-category').textContent=item.category;
   const badge=card.querySelector('.event-status');badge.textContent='진행예정';badge.dataset.state='upcoming';
   card.querySelector('.event-copy strong').textContent=item.title;card.querySelector('.event-copy>span').textContent=item.where+' · '+item.dateLabel;
   card.setAttribute('aria-label',item.category+', 진행예정, '+item.title+', '+item.where+' '+item.dateLabel+', 샘플');
  }
 }
 render();
})();
