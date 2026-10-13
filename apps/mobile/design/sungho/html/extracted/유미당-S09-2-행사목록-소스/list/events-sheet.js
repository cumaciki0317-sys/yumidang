/* Event-filter design controls. Single-selection contracts, no query/filter/search engine.
   Region labels follow event normalize.ts:155–165; live availability remains API-owned. */
const EVENT_REGIONS=['서울','경기','인천','부산','대구','광주','대전','울산','세종','강원','충북','충남','전북','전남','경북','경남','제주'];
const EVENT_TYPES=['전체','전시','축제','팝업','공연','영화'];
const readEventSelection=()=>({type,genre,region,past,ongoing:ongoingValue,free:freeValue,from:fromValue,to:toValue});
let draft=eventDefaults(),lastFocus=null,savedOverflow=null,savedBodyOverflow=null;
function eventOption(label,selected,group,value){return `<button type="button" data-hit-inset-y="3" data-event-group="${group}" data-value="${value}" class="${selected?'selected':''}" aria-pressed="${selected}">${label}</button>`}
function renderFilterSummary(){
 $('#filter-region').hidden=false;$('#filter-admission').hidden=false;
 const selection=readEventSelection();
 for(const [id,on] of [['filter-region',region!=='전체'],['filter-type',type!=='전체'||!!genre],['filter-dates',past||ongoingValue],['filter-admission',freeValue]]){$('#'+id).classList.toggle('selected',on);$('#'+id).setAttribute('aria-label',({ 'filter-region':'지역: '+(region==='전체'?'전체':region),'filter-type':'유형: '+(genre||type),'filter-dates':'일정: '+(past?'과거 행사':'이번 주 신규')+(ongoingValue&&!past?', 진행 중 포함':''),'filter-admission':freeValue?'입장: 무료 입장':'입장: 전체 입장 조건'})[id]+'. 필터 열기');}
 const text=[region==='전체'?'전체':region,genre|| (type==='전체'?'전체 유형':type),past?'과거 행사 조회':'이번 주 신규',ongoingValue&&!past?'진행 중 포함':'',freeValue?'무료 입장':''];
 $('#filter-summary').textContent=text.filter(Boolean).join(' · ');
 if(!$('#event-filters').open){draft=selection;paintEventDraft();}
}
function paintEventDraft(){
 const taxonomyMissing=state==='taxonomyError';
 $('#type-options').innerHTML=(taxonomyMissing?['전체']:EVENT_TYPES).map(v=>eventOption(v,draft.type===v,'type',v)).join('');
 $('#genre-section').hidden=false;$('#genre').innerHTML=['콘서트','뮤지컬','연극'].map(v=>eventOption(v,draft.genre===v,'genre',v)).join('');
 $('#event-regions').hidden=false;$('#region').innerHTML=(taxonomyMissing?['전체']:['전체',...EVENT_REGIONS]).map(v=>eventOption(v==='전체'?'전체':v,draft.region===v,'region',v)).join('');
 $('#event-admission').hidden=false;
 for(const [id,on] of [['week-option',!draft.past],['history',draft.past]]){$('#'+id).classList.toggle('selected',on);$('#'+id).setAttribute('aria-pressed',on);}
 $('#ongoing').checked=draft.ongoing;$('#ongoing').disabled=draft.past;$('#free').checked=draft.free;
 $('#period').hidden=!draft.past;$('#from').value=draft.from;$('#to').value=draft.to;
 const error=state==='invalidPeriod';$('#date-error').hidden=!error;$('#to').setAttribute('aria-invalid',error);$('#to').setAttribute('aria-describedby',error?'date-error':'');
}
function applyEventSelection(){type=draft.type;genre=draft.genre;region=draft.region;past=draft.past;ongoingValue=draft.ongoing;freeValue=draft.free;fromValue=draft.from;toValue=draft.to;limit=10;render();}
function sizeEventSheet(){const r=$('#viewport').getBoundingClientRect(),s=document.documentElement.style;s.setProperty('--frame-left',r.left+'px');s.setProperty('--frame-top',r.top+'px');s.setProperty('--frame-width',r.width+'px');s.setProperty('--frame-height',r.height+'px');s.setProperty('--frame-bottom',Math.max(0,innerHeight-r.bottom)+'px');s.setProperty('--frame-right',Math.max(0,innerWidth-r.right)+'px');}
function lockContent(){if(savedOverflow===null)savedOverflow=$('.event-scroll').style.overflowY||'';if(savedBodyOverflow===null)savedBodyOverflow=document.body.style.overflow||'';document.body.style.overflow='hidden';$('.event-scroll').style.overflowY='hidden';}
function unlockContent(){if($('#event-filters').open)return;document.body.style.overflow=savedBodyOverflow??'';$('.event-scroll').style.overflowY=savedOverflow??'';savedOverflow=null;savedBodyOverflow=null;}
// Keep the native modal and scroll lock alive until its exit transition finishes.
let sheetPhase='closed',sheetEpoch=0,sheetCloseTimer=null;
const reduceSheetMotion=()=>typeof matchMedia!=='function'||matchMedia('(prefers-reduced-motion: reduce)').matches;
function stopSheetClose(){if(sheetCloseTimer!==null){clearTimeout(sheetCloseTimer);sheetCloseTimer=null}}
function openEventFilters(section){
 sizeEventSheet();const dialog=$('#event-filters'),wasOpen=dialog.open,epoch=++sheetEpoch;
 stopSheetClose();resetSheetDrag();draft=readEventSelection();if(!wasOpen)lastFocus=document.activeElement;paintEventDraft();
 dialog.inert=false;dialog.classList.toggle('sheet-closing',false);sheetPhase='opening';
 if(!wasOpen){dialog.classList.toggle('sheet-visible',false);dialog.showModal()}
 lockContent();$('#close-event-filters').focus();
 const reveal=()=>{if(epoch!==sheetEpoch||!dialog.open||sheetPhase==='closing')return;dialog.classList.toggle('sheet-visible',true);sheetPhase='open';if(section==='event-types')$('.event-sheet-body').scrollTop=0;else $('.event-sheet-body').scrollTop=$('#'+section).offsetTop-$('.event-sheet-body').offsetTop};
 if(reduceSheetMotion())reveal();else requestAnimationFrame(()=>requestAnimationFrame(reveal));
}
function closeEventFilters(){
 const dialog=$('#event-filters');if(!dialog.open||sheetPhase==='closing')return;
 const epoch=++sheetEpoch;stopSheetClose();resetSheetDrag();sheetPhase='closing';dialog.inert=true;
 dialog.classList.toggle('sheet-closing',true);dialog.classList.toggle('sheet-visible',false);
 const finish=()=>{if(epoch!==sheetEpoch||sheetPhase!=='closing')return;sheetCloseTimer=null;dialog.close()};
 if(reduceSheetMotion())finish();else sheetCloseTimer=setTimeout(finish,200);
}
$('#event-filters').addEventListener('cancel',e=>{e.preventDefault();closeEventFilters()});
$('#event-filters').addEventListener('close',()=>{
 const dialog=$('#event-filters');if(dialog.open)return; // Ignore a queued old close after a rapid reopen.
 ++sheetEpoch;stopSheetClose();resetSheetDrag();sheetPhase='closed';dialog.inert=false;
 dialog.classList.toggle('sheet-visible',false);dialog.classList.toggle('sheet-closing',false);
 draft=readEventSelection();unlockContent();lastFocus?.focus();
});
$('#event-filters').addEventListener('click',e=>{if(e.target===$('#event-filters')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeEventFilters()}});
$('#event-filters').addEventListener('click',e=>{const b=e.target.closest('[data-event-group]');if(!b||b.disabled||sheetPhase==='closing')return;const {eventGroup:group,value}=b.dataset;if(group==='type'){draft.type=value;draft.genre='';}if(group==='genre'){draft.genre=draft.genre===value?'':value;draft.type='전체';}if(group==='region')draft.region=value;if(group==='period')draft.past=value==='past';paintEventDraft();$(`[data-event-group="${group}"][data-value="${value}"]`)?.focus();});
$('#close-event-filters').onclick=e=>{if(suppressHandleClick&&e?.detail!==0){e?.preventDefault();return}closeEventFilters();};
$('#reset-event-filters').onclick=()=>{draft=eventDefaults();paintEventDraft();};
$('#apply-event-filters').onclick=()=>{if(sheetPhase==='closing')return;applyEventSelection();closeEventFilters();};
// Only a deliberate downward pull starting at the top (or on the handle) dismisses.
let sheetDrag=null,suppressHandleClick=false;
const dragDialog=$('#event-filters'),dragBody=$('.event-sheet-body'),dragHandle=$('#close-event-filters');
function resetSheetDrag(){sheetDrag=null;dragDialog.classList.toggle('sheet-dragging',false);dragDialog.classList.toggle('sheet-returning',false);dragDialog.style.setProperty('--sheet-drag-y','0px')}
function beginSheetDrag(x,y,id,handle,target){
 if(sheetPhase!=='open'||(!handle&&(dragBody.scrollTop>0||target.closest('button,input,select,textarea,label,a,[role="slider"],.age-box'))))return;
 resetSheetDrag();suppressHandleClick=false;sheetDrag={x,y,id,handle,dy:0,active:false};
}
function moveSheetDrag(x,y,id,e){
 const d=sheetDrag;if(!d||d.id!==id)return;const dx=x-d.x,dy=y-d.y;
 if(!d.active){if(Math.abs(dx)<10&&Math.abs(dy)<10)return;if(dy<=0||Math.abs(dx)>dy||(!d.handle&&dragBody.scrollTop>0)){suppressHandleClick=true;resetSheetDrag();return}d.active=true}
 if(e.cancelable)e.preventDefault();d.dy=Math.max(0,Math.min(240,dy));suppressHandleClick=true;
 dragDialog.style.setProperty('--sheet-drag-y',d.dy+'px');dragDialog.classList.toggle('sheet-dragging',true);
}
function endSheetDrag(id,cancel=false){
 const d=sheetDrag;if(!d||d.id!==id)return;const close=!cancel&&d.active&&d.dy>=80;
 resetSheetDrag();if(close)closeEventFilters();else dragDialog.classList.toggle('sheet-returning',true);
}
// Touch scrolling stays native except a downward overscroll begun on empty space at top.
for(const [area,handle] of [[dragHandle,true],[dragBody,false]]){
 area.addEventListener('touchstart',e=>{if(e.touches.length!==1){resetSheetDrag();return}const t=e.touches[0];beginSheetDrag(t.clientX,t.clientY,t.identifier,handle,e.target)},{passive:true});
 area.addEventListener('touchmove',e=>{if(e.touches.length!==1){resetSheetDrag();return}const t=e.touches[0];moveSheetDrag(t.clientX,t.clientY,t.identifier,e)},{passive:false});
 area.addEventListener('touchend',e=>{for(const t of e.changedTouches)endSheetDrag(t.identifier)});
 area.addEventListener('touchcancel',()=>resetSheetDrag());
}
// Mouse/pen drag on the handle; touch is handled above to coexist with native scrolling.
dragHandle.addEventListener('pointerdown',e=>{if(e.pointerType==='touch'||e.button!==0)return;beginSheetDrag(e.clientX,e.clientY,e.pointerId,true,e.target);dragHandle.setPointerCapture?.(e.pointerId)});
dragHandle.addEventListener('pointermove',e=>{if(e.pointerType!=='touch')moveSheetDrag(e.clientX,e.clientY,e.pointerId,e)});
dragHandle.addEventListener('pointerup',e=>{if(e.pointerType!=='touch')endSheetDrag(e.pointerId)});
for(const type of ['pointercancel','lostpointercapture'])dragHandle.addEventListener(type,e=>endSheetDrag(e.pointerId,true));

function dismissEventFilters(){const d=$('#event-filters');if(!d.open)return;++sheetEpoch;stopSheetClose();resetSheetDrag();d.close();}
for(const [id,key] of [['from','from'],['to','to']])$('#'+id).addEventListener('change',e=>{draft[key]=e.target.value;});
for(const [id,key] of [['ongoing','ongoing'],['free','free']])$('#'+id).addEventListener('change',e=>{draft[key]=e.target.checked;});
document.querySelectorAll('[data-event-filter]').forEach(b=>b.onclick=()=>openEventFilters(b.dataset.eventFilter));
addEventListener('resize',sizeEventSheet);
if(typeof ResizeObserver==='function')new ResizeObserver(sizeEventSheet).observe($('#viewport'));
if(typeof window!=='undefined'&&window.visualViewport)window.visualViewport.addEventListener('resize',sizeEventSheet);
if(document.fonts?.ready)document.fonts.ready.then(sizeEventSheet);
renderFilterSummary();sizeEventSheet();
