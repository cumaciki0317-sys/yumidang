/* Fixed display scenes and UI events only. No routing, storage or query engine. */
const week={label:'9월 4주차'};
const eventDefaults=()=>({type:'전체',genre:'',region:'전체',past:false,ongoing:false,free:false,from:'',to:''});
let state='default',rank='all',region='전체',type='전체',genre='',limit=10,past=false,ongoingValue=false,freeValue=false,fromValue='',toValue='';
const $=s=>document.querySelector(s),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isSelecting=()=>state==='picker'||state==='pickerPast';
function results(){
 if(state==='longText')return DISPLAY_SETS.default.map((e,i)=>i===0?{...e,title:'도시의 기억을 걷다 — 일상과 예술의 경계를 만나는 특별 기획전',venue:'서울문화예술전시센터 기획전시관',fee:'무료 · 일부 체험 유료'}:e);

 if(['more','moreError','pageError'].includes(state))return DISPLAY_SETS.more;
 if(['past','pickerPast','invalidPeriod'].includes(state))return DISPLAY_SETS.pastRemote;
 return state==='ongoing'?DISPLAY_SETS.ongoing:DISPLAY_SETS.default;
}
const rankingFixtures={all:[['뮤지컬 가을밤','서울 뮤지컬 극장'],['연극〈늘근도둑이야기〉','대학로 아트포레스트'],['가을 실내악 공연','세종문화회관 대극장'],['DAY6 팬미팅 콘서트','인스파이어 아레나'],['국립발레단 해적','국립극장 해오름']],musical:[['뮤지컬 가을밤','서울 뮤지컬 극장'],['지킬 앤 하이드','블루스퀘어 신한카드홀'],['시카고','디큐브 링크아트센터'],['킹키부츠','LG아트센터 서울'],['하데스타운','샤롯데씨어터']]};
const pin='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/></svg>';
function renderRanks(){const data=rankingFixtures[rank];$('#ranks').innerHTML=state==='rankLoading'?'<div class="empty">순위를 확인하고 있어요…</div>':state==='rankError'?'<div class="empty">공식 순위가 아직 수신되지 않았어요.</div>':Array.from({length:10},(_,i)=>{const item=data[i]||[(rank==='musical'?'뮤지컬':'공연')+' 예시 '+(i+1),'예시 공연장'];return `<article class="rank-item"><div class="poster rank-decoration" aria-hidden="true"><span class="decorative-note">♪</span></div><span class="rank-number">${i+1}</span><h3>${esc(item[0])}</h3><footer><span>KOPIS</span><span>합성 순위 예시</span></footer></article>`}).join('');document.querySelectorAll('[data-rank]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.rank===rank));}

const categoryAssets='../../유미당-디자인시스템/유미당-디자인시스템/screens/home/assets/';
const categoryIcons={'전시':'exhibit.svg','공연':'show.svg','축제':'festival-icon.svg','팝업':'popup.svg','영화':'movie.svg'};
function eventImage(e){
 const sample=state==='imageSample',url=sample?'assets/concert-1-5.png':state==='imageMissing'?null:e.imageUrl;
 const fallback=`<span class="image-fallback" role="img" aria-label="${esc(e.type)} 이미지 없음"><img src="${categoryAssets+(categoryIcons[e.type]||'exhibit.svg')}" alt=""><span>이미지 없음</span></span>`;
 return `<span class="event-thumb">${fallback}${url?`<img class="event-photo" src="${esc(url)}" alt="${sample?'배치 검수용 샘플 이미지':esc(e.title)+' 행사 이미지'}" onerror="this.hidden=true;this.parentElement.querySelector('.image-fallback').hidden=false;const label=this.parentElement.querySelector('.sample-label');if(label)label.hidden=true" onload="this.parentElement.querySelector('.image-fallback').hidden=true">${sample?'<span class="sample-label">샘플 이미지</span>':''}`:''}</span>`;
}
function periodText(value){const parts=String(value).split(' ~ ');return parts.map((part,i)=>`<span class="date-unit">${esc(part)}${i<parts.length-1?' ~':''}</span>`).join('<wbr> ');}
function card(e){const selecting=isSelecting(),ended=e.ended;
 return `<article class="event-card ${ended?'ended':''}"><button class="event-row" data-event="${e.id}" ${selecting&&ended?'disabled':''} aria-label="${esc(e.title)} ${selecting?'연결하기':'상세 보기'}"><span class="meta"><span class="event-kicker"><small class="badge event-status ${e.ended?'status-ended':e.statusLabel==='진행 중'?'status-ongoing':'status-upcoming'}">${esc(e.statusLabel)}</small><small>${esc(e.type)}</small></span><b>${esc(e.title)}</b><span class="venue">${pin}<span>${e.area?esc(e.area)+' · ':''}${esc(e.venue)} <wbr><span class="inline-fee"><span aria-hidden="true"> · </span>${esc(e.fee)}</span></span></span><small class="date-line">${periodText(e.periodLabel)}</small></span>${eventImage(e)}</button><div class="companion-row">${e.posts?`<button type="button" class="related-link related-posts" data-related-event="${e.id}" aria-label="${esc(e.title)} 연결 공고 ${e.posts}건 보기">동행 공고 ${e.posts}건 보기 <span aria-hidden="true">›</span></button>`:'<span class="related-count">연결 공고 없음</span>'}${selecting?`<button class="related-link picker-link" data-event="${e.id}" ${ended?'disabled':''}>이 행사 연결하기 ›</button>`:''}</div></article>`;
}
function render(){const selecting=isSelecting(),invalid=state==='invalidPeriod';
 $('#title').textContent=selecting?'연결할 행사 선택':'행사 둘러보기';$('#rank-section').hidden=selecting;
 $('#bell').hidden=state==='guest';$('#login').hidden=state!=='guest';
 $('#picker-note').hidden=!selecting;$('#picker-note').textContent='행사를 연결해도 작성 중인 동행 일정은 바뀌지 않아요.';
 $('#taxonomy-error').hidden=state!=='taxonomyError';
 $('#rank-source').textContent='KOPIS · 합성 집계 기간 2026.09.15 ~ 2026.09.21 · 갱신 예시 2026.09.22 · 실제 순위 미연결';
 $('#rank-label').hidden=['rankError','rankLoading'].includes(state);$('#rank-source').hidden=['rankError','rankLoading'].includes(state);
 $('#general-heading').textContent=past?'과거 기간 행사':'이번 주 문화 행사';
 $('#range-summary').textContent=week.label+' · '+(past?'선택 기간과 겹치는 행사':'이번 주 신규 중 미종료');
 const rows=results();$('#count').textContent='';$('#count').hidden=true;
 $('#list').innerHTML=invalid?'':state==='loading'?'<div class="empty">행사를 확인하고 있어요…</div>':state==='error'?'<div class="empty">행사를 불러오지 못했어요.<button class="secondary wide" id="retry">다시 시도</button></div>':state==='empty'||!rows.length?`<div class="empty">조건에 맞는 행사가 없어요.<br>카테고리 또는 진행 중 포함 조건을 바꿔 보세요.<button class="secondary wide" id="reset">조건 초기화</button></div>`:`<div class="rows">${rows.slice(0,limit).map(card).join('')}</div>${state==='pageError'?'<div class="empty">행사를 더 불러오지 못했어요.<button class="secondary wide" id="retry-page">다시 시도</button></div>':''}${rows.length>limit?'<button class="secondary wide" id="more">행사 10개 더 보기</button>':''}`;
 renderRanks();if(typeof renderFilterSummary==='function')renderFilterSummary();
}
function resetView(){({type,genre,region,past,ongoing:ongoingValue,free:freeValue,from:fromValue,to:toValue}=eventDefaults());rank='all';limit=10;}
function setScenario(next){if(typeof dismissEventFilters==='function')dismissEventFilters();resetView();state=next==='moreError'?'pageError':next;ongoingValue=next==='ongoing';past=['past','pickerPast','invalidPeriod'].includes(next);if(past){fromValue='2026-08-01';toValue=next==='invalidPeriod'?'2026-07-01':'2026-09-10';}render();if(next==='invalidPeriod'&&typeof openEventFilters==='function')openEventFilters('event-dates');}
$('#mode').addEventListener('change',e=>setScenario(e.target.value));
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;
 if(b.dataset.rank){rank=b.dataset.rank;renderRanks();}
 if(b.id==='more'){limit+=10;render();}
 if(b.id==='reset'){$('#mode').value='default';setScenario('default');}
});
resetView();render();
