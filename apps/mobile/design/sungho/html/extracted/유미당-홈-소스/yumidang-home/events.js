/* Five native card controls with horizontal swipe and drag-safe press interaction. */
(()=>{
 const track=document.getElementById('event-track'),cards=[...track.querySelectorAll('[data-event-id]')],announcement=document.getElementById('event-announcement');
 const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
 let index=0,drag=null,suppressClick=false;
 const step=()=>Math.max(1,cards[1].offsetLeft-cards[0].offsetLeft);
 const clamp=i=>Math.max(0,Math.min(cards.length-1,i));
 function update(){index=clamp(Math.round(track.scrollLeft/step()));const message=`이벤트 ${index+1} / ${cards.length}`;if(announcement.textContent!==message)announcement.textContent=message}
 function go(i,instant=false){index=clamp(i);track.scrollTo({left:index*step(),behavior:instant||reduced()?'auto':'smooth'});if(instant)update()}
 track.addEventListener('scroll',update,{passive:true});
 track.addEventListener('keydown',e=>{const key=e.key;if(!['ArrowLeft','ArrowRight','Home','End'].includes(key))return;e.preventDefault();go(key==='Home'?0:key==='End'?cards.length-1:index+(key==='ArrowRight'?1:-1),true)});
 track.addEventListener('pointerdown',e=>{if(e.isPrimary===false||e.button!==0)return;suppressClick=false;drag={id:e.pointerId,type:e.pointerType,x:e.clientX,y:e.clientY,scroll:track.scrollLeft,moved:false}});
 track.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(dx,dy)>8)drag.moved=true;if(drag.type==='mouse'&&drag.moved){track.classList.add('dragging');if(!track.hasPointerCapture(e.pointerId))track.setPointerCapture(e.pointerId);e.preventDefault();track.scrollLeft=drag.scroll-dx*(track.offsetWidth/track.getBoundingClientRect().width)}});
 function end(e){if(!drag||drag.id!==e.pointerId)return;const mouse=drag.type==='mouse',moved=drag.moved;suppressClick=moved;drag=null;track.classList.remove('dragging');if(track.hasPointerCapture(e.pointerId))track.releasePointerCapture(e.pointerId);if(mouse&&moved){update();go(index)}}
 window.addEventListener('pointerup',end);window.addEventListener('pointercancel',end);window.addEventListener('blur',()=>{drag=null;track.classList.remove('dragging')});
 track.addEventListener('click',e=>{if(suppressClick&&e.detail!==0){suppressClick=false;e.preventDefault();e.stopImmediatePropagation()}},true);
 track.addEventListener('dragstart',e=>e.preventDefault());
 addEventListener('resize',()=>go(index,true));
 update();
})();
