// Source-bound carousel tests; no browser/native-touch claims.
const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');let checks=0;
const ok=x=>{assert.ok(x);checks++},eq=(a,b)=>{assert.deepEqual(a,b);checks++};
const html=fs.readFileSync(__dirname+'/index.html','utf8'),css=fs.readFileSync(__dirname+'/events.css','utf8'),js=fs.readFileSync(__dirname+'/events.js','utf8');
const markup=[...html.matchAll(/<button type="button" class="event-card" data-press-surface="true" data-event-id="([^"]+)"/g)];eq(markup.length,5);eq(new Set(markup.map(m=>m[1])).size,5);
const nodes=new Map(),windowEvents={};let active,now=100;
function node(id){if(nodes.has(id))return nodes.get(id);const n={id,style:{},dataset:{},attrs:{},scrollLeft:0,scrollTop:0,offsetWidth:859,offsetLeft:0,hidden:false,inert:false,disabled:false,listeners:{},classList:{add(){},remove(){}},addEventListener(t,f){(this.listeners[t]??=[]).push(f)},dispatch(t,e={}){for(const f of this.listeners[t]??[])f({type:t,target:this,button:0,pointerId:1,pointerType:'touch',isPrimary:true,detail:1,clientX:0,clientY:0,preventDefault(){this.prevented=true},stopImmediatePropagation(){this.stopped=true},...e})},setAttribute(k,v){this.attrs[k]=v},focus(){active=this},getBoundingClientRect(){return {width:859*360/945}},scrollTo(o){this.scrollLeft=o.left;this.dispatch('scroll')},hasPointerCapture(id){return this.capture===id},setPointerCapture(id){this.capture=id},releasePointerCapture(){this.capture=null},closest(s){return s==='[data-event-id]'&&this.dataset.eventId?this:null},querySelector(){return {cloneNode:()=>({source:this.dataset.eventId})}},replaceChildren(...n){this.children=n}};nodes.set(id,n);return n}
const announcement=node('event-announcement');
const cards=markup.map((m,i)=>{const n=node('card'+i);n.dataset.eventId=m[1];n.offsetLeft=i*840;return n}),track=node('event-track');track.querySelectorAll=()=>cards;
const emit=(type,e={})=>(windowEvents[type]||[]).forEach(f=>f({type,pointerId:1,clientX:0,clientY:0,...e}));
let reduced=false;
const context={document:{getElementById:node,querySelectorAll:()=>[]},window:{addEventListener(t,f){(windowEvents[t]??=[]).push(f)}},addEventListener(t,f){(windowEvents[t]??=[]).push(f)},matchMedia:()=>({matches:reduced})};vm.runInNewContext(js,context);
function selected(i){eq(announcement.textContent,`이벤트 ${i+1} / 5`)}
selected(0);
for(let i=0;i<5;i++){track.scrollLeft=i*840;track.dispatch('scroll');selected(i);track.dispatch('click',{target:cards[i]});selected(i);eq(track.listeners.click.length,1)}
track.dispatch('keydown',{key:'End'});eq(track.scrollLeft,4*840);track.dispatch('keydown',{key:'Home'});eq(track.scrollLeft,0);
track.dispatch('keydown',{key:'ArrowRight'});eq(track.scrollLeft,840);track.dispatch('keydown',{key:'ArrowLeft'});eq(track.scrollLeft,0);
track.dispatch('pointerdown',{pointerType:'mouse',clientX:200});track.dispatch('pointermove',{pointerType:'mouse',clientX:100});ok(track.scrollLeft>0);emit('pointerup',{clientX:100});ok(track.scrollLeft%840===0);
track.dispatch('pointerdown');track.dispatch('pointermove',{clientX:35});emit('pointercancel');track.dispatch('click',{target:cards[1]});eq(track.listeners.click.length,1);
track.scrollLeft=4*840;track.dispatch('scroll');emit('resize');eq(track.scrollLeft,4*840);selected(4);
for(const term of ['scroll-snap-type:x mandatory','overflow-x:auto','flex:0 0 95%','touch-action:pan-x pan-y','height:161.904761905px'])ok(css.includes(term));
for(const term of ['event-detail','event-progress','event-position','event-previous','event-next','축제 상세 보기'])ok(!html.includes(term)&&!css.includes(term)&&!js.includes(term));
for(const term of ['history','location','popstate','hashchange','setInterval'])ok(!js.includes(term));
eq((html.match(/class="event-dot"/g)||[]).length,0);ok(html.includes('.login{font-size:0.714285714rem;font-weight:400}'));ok(!html.includes('이번 주 신규 등록'));ok(!html.includes('event-navigation'));ok(html.includes('aria-live="polite"'));ok(!html.includes('id="event-announcement" tabindex'));ok(html.includes('<button type="button" class="event-card"'));ok(html.includes('class="event-image press-surface"'));
let prevented=0,stopped=0;
track.dispatch('pointerdown',{pointerType:'mouse',clientX:200,clientY:0});track.dispatch('pointermove',{pointerType:'mouse',clientX:180,clientY:0});emit('pointerup');track.dispatch('click',{detail:1,preventDefault(){prevented++},stopImmediatePropagation(){stopped++}});eq(prevented,1);eq(stopped,1);
track.dispatch('pointerdown',{pointerType:'mouse',clientX:100,clientY:0});emit('pointerup');track.dispatch('click',{detail:1,preventDefault(){prevented++},stopImmediatePropagation(){stopped++}});eq(prevented,1);
track.dispatch('pointerdown',{pointerType:'touch',clientX:100,clientY:0});track.dispatch('pointermove',{pointerType:'touch',clientX:90,clientY:0});emit('pointerup');track.dispatch('click',{detail:0,preventDefault(){prevented++},stopImmediatePropagation(){stopped++}});eq(prevented,1);
ok(css.includes('.event-card:last-child{flex-basis:100%;margin-right:0}'));ok(!css.includes('margin-right:5%'));const available=859,regular=available*.95,gap=24,last=available,total=4*regular+4*gap+last,maxScroll=total-available,lastStart=4*(regular+gap);ok(Math.abs(maxScroll-lastStart)<1e-9);eq(last,available);ok(regular<available);eq(lastStart+last-maxScroll,available);
track.scrollLeft=4*840;track.dispatch('scroll');selected(4);track.dispatch('keydown',{key:'End'});eq(track.scrollLeft,4*840);emit('resize');eq(track.scrollLeft,4*840);
console.log(checks+' carousel UI/source assertions passed; browser rendering and real touch not tested.');
