/* A transient, aria-hidden visual layer leaves the native button, layout, events,
   keyboard activation and hit area intact. No persistent pressed/selected state. */
(()=>{
 const active=new Map();
 const reduced=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
 const target=e=>e.target?.closest?.('button');
 const disabled=b=>!b||b.disabled||b.getAttribute('aria-disabled')==='true'||b.closest('[inert]');
 function remove(b){const s=active.get(b);if(!s)return;clearTimeout(s.timer);if(s.persistent)s.visual.style.transform=s.originalTransform;else s.visual.remove();if(s.position!==null)b.style.position=s.position;b.classList.remove('press-rendering');active.delete(b)}
 function release(b,immediate=false){const s=active.get(b);if(!s)return;s.down=false;s.visual.style.transform='scale(1)';if(immediate||reduced())remove(b);else{s.timer=setTimeout(()=>remove(b),100)}}
 function start(b,kind,id,point){
  if(disabled(b))return;remove(b);
  // Translucent cards keep one existing paint surface in its original compositing context.
  const surface=b.getAttribute('data-press-surface')==='true'?b.querySelector('.press-surface'):null;
  if(surface){const s={visual:surface,kind,id,down:true,timer:null,position:null,persistent:true,originalTransform:surface.style.transform,dragSensitive:b.getAttribute('data-event-id')!==null,originX:point?.clientX,originY:point?.clientY};active.set(b,s);surface.getBoundingClientRect();surface.style.transform='scale(.96)';return}
  const c=getComputedStyle(b),v=document.createElement('button');
  // Copy the current selected/unselected paint without changing source selectors.
  v.className=b.className+' press-visual';
  for(const p of c)v.style.setProperty(p,c.getPropertyValue(p));
  v.innerHTML=b.innerHTML;
  v.querySelectorAll('[id]').forEach(n=>n.removeAttribute('id'));
  v.querySelectorAll('[aria-live]').forEach(n=>n.removeAttribute('aria-live'));
  // Preserve the native button's anonymous centered content box, including inline baselines.
  // This inert visual replica cannot submit, receive focus, or handle input.
  v.type='button';v.tabIndex=-1;v.setAttribute('aria-hidden','true');v.inert=true;
  const extent=(axis)=>{const value=parseFloat(c[axis]);if(!Number.isFinite(value))return axis==='width'?b.offsetWidth:b.offsetHeight;const edges=axis==='width'?['paddingLeft','paddingRight','borderLeftWidth','borderRightWidth']:['paddingTop','paddingBottom','borderTopWidth','borderBottomWidth'];return value+(c.boxSizing==='content-box'?edges.reduce((sum,key)=>sum+(parseFloat(c[key])||0),0):0)};
  Object.assign(v.style,{position:'absolute',left:-parseFloat(c.borderLeftWidth||0)+'px',top:-parseFloat(c.borderTopWidth||0)+'px',right:'auto',bottom:'auto',width:extent('width')+'px',height:extent('height')+'px',minWidth:'0',maxWidth:'none',minHeight:'0',maxHeight:'none',margin:'0',boxSizing:'border-box',transform:'scale(1)',translate:'none',rotate:'none',scale:'none',opacity:'1',zIndex:'1'});
  // Relative positioning does not move an otherwise static native button.
  const position=c.position==='static'?b.style.position:null;
  if(position!==null)b.style.position='relative'
  b.append(v);b.classList.add('press-rendering');
  const s={visual:v,kind,id,down:true,timer:null,position};active.set(b,s);
  // Flush the initial scale so both press and release use the approved 100 ms.
  v.getBoundingClientRect();v.style.transform='scale(.96)';
 }
 function releaseAll(immediate=true){for(const b of [...active.keys()])release(b,immediate)}
 document.addEventListener('pointerdown',e=>{if(e.isPrimary===false||e.button!==0)return;start(target(e),'pointer',e.pointerId,e)},true);
 document.addEventListener('pointermove',e=>{for(const [b,s] of active){if(s.kind!=='pointer'||s.id!==e.pointerId||!s.down)continue;if(s.dragSensitive&&Math.hypot(e.clientX-s.originX,e.clientY-s.originY)>8){remove(b);continue}const r=b.getBoundingClientRect();s.visual.style.transform=e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom?'scale(.96)':'scale(1)'}},true);
 for(const type of ['pointerup','pointercancel','lostpointercapture'])document.addEventListener(type,e=>{for(const [b,s] of [...active])if(s.kind==='pointer'&&s.id===e.pointerId)release(b,type!=='pointerup')},true);
 document.addEventListener('keydown',e=>{if((e.key===' '||e.key==='Enter')&&!e.repeat)start(target(e),'keyboard',e.key)},true);
 document.addEventListener('keyup',e=>{for(const [b,s] of [...active])if(s.kind==='keyboard'&&s.id===e.key)release(b)},true);
 document.addEventListener('focusout',e=>{const b=target(e);if(b)release(b,true)},true);
 window.addEventListener('blur',()=>releaseAll());
 document.addEventListener('visibilitychange',()=>{if(document.hidden)releaseAll()});
 // Dynamic labels/selection, disabled transitions and replaced filter buttons reset safely.
 new MutationObserver(records=>{for(const [b,s] of [...active]){if(!b.isConnected||disabled(b)||s.visual.parentNode!==b){remove(b);continue}if(records.some(r=>r.target!==s.visual&&!s.visual.contains(r.target)&&((r.type==='attributes'&&r.target===b&&r.attributeName!=='class'&&r.attributeName!=='style')||(r.type==='childList'&&b.contains(r.target)&&[...r.addedNodes,...r.removedNodes].some(n=>n!==s.visual))||(r.type==='characterData'&&b.contains(r.target)))))remove(b)}}).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','aria-disabled','inert']});
})();
