/* Home UI state preview only. Controls live outside the app frame. */
(()=>{
'use strict';
const $=id=>document.getElementById(id),radios=[...document.querySelectorAll('[name="demo-state"]')];
const account=$('account-button'),placeholder=$('appointment-placeholder'),slot=$('private-slot');
const demoUser=Object.freeze({name:'이민정',avatarUrl:'assets/provided-profile-display.webp'});
const demoAppointment=Object.freeze({dDayLabel:'D-3',companionName:'유지민',companionAvatarUrl:'assets/companion-profile.webp'}); // Replaceable display data, not a date calculation.
const userName=$('account-name'),profileGroup=$('account-profile'),avatar=$('account-avatar');
const descriptions={guest:'로그인 전: 로그인 버튼과 약속 안내를 표시합니다. 프로필과 알림 종은 표시하지 않습니다.',empty:'로그인 후 · 약속 없음: 프로필과 알림, 두 줄 안내를 표시합니다.',booked:'로그인 후 · 약속 있음: 프로필과 알림, 카드 전체 눌림 표현을 표시합니다.',ongoing:'로그인 후 · 진행 중인 약속: 진행 중 표시와 확정된 동행자 정보를 표시합니다.'};
let state='guest',demoUnread=true;
const bell=$('notification-button'),unreadControl=$('demo-unread'),notificationDot=$('notification-dot');
function renderNotification(){bell.hidden=state==='guest';const visible=state!=='guest'&&demoUnread;bell.classList.toggle('has-unread',visible);notificationDot.hidden=!visible;bell.setAttribute('aria-label',visible?'알림 · 읽지 않은 알림 있음':'알림');unreadControl.checked=demoUnread;unreadControl.disabled=state==='guest'}
function render(next){
 if(!Object.hasOwn(descriptions,next))return;
 state=next;
 for(const radio of radios)radio.checked=radio.value===state;
 account.hidden=state!=='guest';account.textContent='로그인';
 account.setAttribute('aria-label','로그인');account.title='로그인';
 profileGroup.hidden=state==='guest';
 avatar.hidden=true;
 if(state!=='guest'&&demoUser.avatarUrl)avatar.setAttribute('src',demoUser.avatarUrl);else avatar.removeAttribute('src');
 userName.hidden=state==='guest';
 userName.textContent=state==='guest'?'':demoUser.name;
 userName.title=state==='guest'?'':demoUser.name;
 userName.setAttribute('aria-label',state==='guest'?'':demoUser.name);
 $('demo-signout').disabled=state==='guest';
 const hasAppointment=state==='booked'||state==='ongoing';$('appointment-all').hidden=state==='guest';
 placeholder.hidden=hasAppointment;slot.replaceChildren();
 if(hasAppointment){const card=$('appointment-template').content.cloneNode(true);card.querySelector('[data-dday-label]').textContent=state==='ongoing'?'진행 중':demoAppointment.dDayLabel;card.querySelector('[data-companion-name]').textContent=demoAppointment.companionName;card.querySelector('[data-self-avatar]').setAttribute('src',demoUser.avatarUrl);card.querySelector('[data-companion-avatar]').setAttribute('src',demoAppointment.companionAvatarUrl);card.querySelector('[data-companion-status]').textContent=state==='ongoing'?' 님과 동행 중':' 님과의 동행 예정';card.querySelector('#private-appointment').setAttribute('aria-label',`국립현대미술관 전시 관람 · ${state==='ongoing'?'진행 중':'예정, '+demoAppointment.dDayLabel} · 10월 11일 오후 2시 · 종로구 삼청동 · 약속 상세 보기 · 샘플`);slot.append(card)}
 placeholder.classList.toggle('is-guest',state==='guest');
 $('placeholder-title').textContent=state==='guest'?'로그인 후 확인할 수 있어요':'확정된 약속이 없어요\n마음에 드는 공고에 동행을 요청해 보세요';
 $('placeholder-description').hidden=true;
 $('placeholder-description').textContent='';
 $('state-description').textContent=descriptions[state];
 renderNotification();if(typeof window!=='undefined')window.YumidangHomeLayout?.refresh();
}

for(const radio of radios)radio.addEventListener('change',()=>{if(radio.checked)render(radio.value)});
unreadControl.addEventListener('change',()=>{demoUnread=unreadControl.checked;renderNotification()});
$('demo-signout').addEventListener('click',()=>{render('guest');radios[0].focus()});
avatar.addEventListener('load',()=>{if(state!=='guest'&&avatar.getAttribute('src'))avatar.hidden=false});
avatar.addEventListener('error',()=>{avatar.hidden=true;avatar.removeAttribute('src')});
const eventChoice=$('demo-events'),eventCarousel=$('event-carousel'),eventPlaceholder=$('event-placeholder');
eventPlaceholder.setAttribute('aria-labelledby','event-placeholder-title');
$('event-placeholder-title').setAttribute('role','status');
$('event-placeholder-title').setAttribute('aria-live','polite');
$('event-placeholder-title').setAttribute('aria-atomic','true');
function renderEvents(){
 const value=eventChoice.value||'default';eventCarousel.hidden=value!=='default';eventPlaceholder.hidden=value==='default';
 $('event-placeholder-title').textContent=value==='error'?'행사를 불러오지 못했어요':'이번 주 새로 시작하는 미종료 행사가 없어요';
 $('event-placeholder-action').textContent=value==='error'?'다시 시도':'진행 중인 행사도 둘러보기';
 $('event-placeholder-action').hidden=false;if(typeof window!=='undefined')window.YumidangHomeLayout?.refresh();
}
eventChoice.addEventListener('change',renderEvents);
// UI events only. Select fixed display scenes in the external review panel.
renderEvents();render('guest');
})();
