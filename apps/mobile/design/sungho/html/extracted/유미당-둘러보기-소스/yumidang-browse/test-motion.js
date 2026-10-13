// Event wiring tests with a minimal DOM harness. This is NOT browser rendering QA.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
function environment(guest=false,motion=true){
 const nodes=new Map();let document;
 function node(key){if(nodes.has(key))return nodes.get(key);const listeners={};const n={key,value:'',checked:false,hidden:false,disabled:false,dataset:{},style:{setProperty(k,v){this[k]=v}},textContent:'',innerHTML:'',scrollHeight:2400,scrollTop:0,classList:{values:new Set(),toggle(k,on){if(on)this.values.add(k);else this.values.delete(k)},contains(k){return this.values.has(k)}},setAttribute(){},closest(){return null},focus(){document.activeElement=n},scrollIntoView(){},getBoundingClientRect(){return {left:0,top:100,right:600,bottom:900}},addEventListener(t,f){(listeners[t]??=[]).push(f)},dispatch(t,e={}){for(const f of listeners[t]??[])f({...e,target:e.target??n})},showModal(){n.open=true},close(){n.open=false;n.dispatch('close')}};nodes.set(key,n);return n}
 const filterButtons=['categories','regions','dates','ages','categories'].map((v,i)=>{let n=node('filter'+i);n.dataset.filter=v;return n});
 document={getElementById:id=>node('#'+id),documentElement:node('html'),querySelector:node,querySelectorAll:s=>s==='[data-filter]'?filterButtons:[],body:{style:{},classList:{toggle(){}}},fonts:{ready:Promise.resolve()},activeElement:node('initial')};
 node('#sort').value='newest';
 let now=0,serial=0;const timers=new Map(),frames=[];const tick=ms=>{now+=ms;for(const [id,t] of [...timers])if(t.at<=now){timers.delete(id);t.fn()}};const flushFrames=()=>{while(frames.length)frames.shift()()};
 const context={matchMedia:()=>({matches:!motion}),setTimeout:(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:now+ms});return id},clearTimeout:id=>timers.delete(id),document,location:{search:guest?'?guest=1':''},URLSearchParams,structuredClone,innerWidth:390,innerHeight:844,addEventListener(){},requestAnimationFrame:f=>frames.push(f),module:{exports:{}},console};vm.runInNewContext(fs.readFileSync(__dirname+'/browse.js','utf8'),context);return {node,document,filterButtons,context,tick,flushFrames,timers};
}
function select(e,group,value){const button={dataset:{group,value}};e.node('#filters').dispatch('click',{target:{closest:()=>button}})}

let checks=0;const check=(v)=>{assert.ok(v);checks++};
let e=environment(),d=e.node('#filters'),initial=e.document.activeElement;
e.filterButtons[0].onclick();check(d.open);check(!d.classList.contains('sheet-visible'));e.flushFrames();check(d.classList.contains('sheet-visible'));
select(e,'category','전시');e.node('#close-filters').onclick();check(d.open&&d.inert);check(e.node('.app-scroll').style.overflowY==='hidden');e.tick(199);check(d.open);e.tick(1);check(!d.open&&!d.inert);check(e.document.activeElement===initial);check(e.node('.app-scroll').style.overflowY==='');
e.filterButtons[0].onclick();e.flushFrames();check(e.node('#apply-filters').textContent==='적용하기 (3건)');
let prevented=false;d.dispatch('cancel',{preventDefault(){prevented=true}});check(prevented&&d.open);d.dispatch('cancel',{preventDefault(){}});check(e.timers.size===1);e.tick(200);check(!d.open);
e.filterButtons[0].onclick();e.flushFrames();select(e,'category','전시');e.node('#apply-filters').onclick();check(e.node('#count').textContent===3&&d.open);e.tick(200);check(!d.open);e.filterButtons[0].onclick();e.flushFrames();check(e.node('#apply-filters').textContent==='적용하기 (3건)');
// Backdrop uses the same delayed close.
d.dispatch('click',{clientX:20,clientY:20,target:d});check(d.open&&d.inert);e.tick(200);check(!d.open);
// Rapid close/open cancels pending exit and stale entry callbacks.
e.filterButtons[0].onclick();e.node('#close-filters').onclick();e.tick(100);e.filterButtons[1].onclick();e.tick(150);e.flushFrames();check(d.open&&!d.inert);check(d.classList.contains('sheet-visible'));check(e.node('.app-scroll').style.overflowY==='hidden');check(e.timers.size===0);
// Old queued native close event must not tear down a reopened modal.
d.dispatch('close');check(d.open&&e.node('.app-scroll').style.overflowY==='hidden');
// External native close cleans up an in-flight exit.
e.node('#close-filters').onclick();d.close();e.tick(400);check(!d.open&&e.timers.size===0);check(e.node('.app-scroll').style.overflowY==='');
// Reduced motion does not schedule entry/exit delays.
e=environment(false,false);d=e.node('#filters');e.filterButtons[0].onclick();check(d.open&&d.classList.contains('sheet-visible'));e.node('#close-filters').onclick();check(!d.open&&e.timers.size===0);
console.log(checks+' motion lifecycle assertions passed (mock timers/DOM; no browser paint)');

module.exports={environment};
