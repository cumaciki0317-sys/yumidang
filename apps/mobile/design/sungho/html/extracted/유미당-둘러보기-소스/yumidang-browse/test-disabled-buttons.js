// Contract and lifecycle tests with mocked DOM, not browser rendering.
const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');let count=0;
const eq=(a,b)=>{assert.deepEqual(a,b);count++},ok=a=>{assert.ok(a);count++};
let events={},win={},timers=[],mutation,reduced=false;
class Node{constructor(tag='button'){this.tag=tag;this.attrs={};this.className='robot glass';this.style={position:'',setProperty(k,v){this[k]=v}};this.children=[];this.innerHTML='<img>';this.disabled=false;this.isConnected=true;this.offsetWidth=113;this.offsetHeight=115;this.classList={add:x=>{this.className+=' '+x},remove:x=>{this.className=this.className.split(' ').filter(y=>y!==x).join(' ')}}}getAttribute(x){return this.attrs[x]??null}setAttribute(x,v){this.attrs[x]=v}closest(s){return s==='button'&&this.tag==='button'?this:null}querySelectorAll(){return []}append(v){this.children.push(v);v.parentNode=this}remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(x=>x!==this);this.parentNode=null}contains(n){return n===this||this.children.includes(n)}getBoundingClientRect(){return {left:10,top:20,right:123,bottom:135}}}
const document={addEventListener(t,f){(events[t]??=[]).push(f)},createElement:t=>new Node(t),documentElement:new Node('html'),hidden:false};
const context={document,window:{addEventListener(t,f){(win[t]??=[]).push(f)}},matchMedia:()=>({matches:reduced}),getComputedStyle:()=>{const o=['background','color'];Object.assign(o,{position:'static',borderLeftWidth:'1px',borderTopWidth:'1px',getPropertyValue:p=>p==='color'?'rgb(107, 114, 128)':'linear-gradient(white,purple)'});return o},MutationObserver:class{constructor(f){mutation=f}observe(){}},setTimeout:f=>{timers.push(f);return timers.length},clearTimeout:id=>{timers[id-1]=null}};
vm.runInNewContext(fs.readFileSync(__dirname+'/press-feedback.js','utf8'),context);
const fire=(type,b,rest={})=>(events[type]||[]).forEach(f=>f({target:b,button:0,pointerId:4,isPrimary:true,clientX:25,clientY:25,...rest}));const flush=()=>{const ts=timers;timers=[];ts.forEach(f=>f?.())};
let b=new Node;fire('pointerdown',b);eq(b.children.length,1);let v=b.children[0];eq(v.tag,'button');eq(v.style.transform,'scale(.96)');eq(v.getAttribute('aria-hidden'),'true');eq(v.inert,true);eq(v.style.width,'113px');eq(v.style.height,'115px');eq(v.style.left,'-1px');eq(v.style.rotate,'none');eq(b.offsetWidth,113);eq(b.offsetHeight,115);eq(b.getBoundingClientRect(),{left:10,top:20,right:123,bottom:135});eq(b.style.transform,undefined);eq(b.style.position,'relative');eq(v.style.color,'rgb(107, 114, 128)');
fire('pointermove',b,{clientX:150});eq(v.style.transform,'scale(1)');fire('pointermove',b);eq(v.style.transform,'scale(.96)');fire('pointerup',b);eq(v.style.transform,'scale(1)');eq(b.children.length,1);flush();eq(b.children.length,0);eq(b.style.position,'');ok(!b.className.includes('press-rendering'));
for(const t of ['pointercancel','lostpointercapture','focusout']){fire('pointerdown',b);fire(t,b);eq(b.children.length,0)}
for(const key of [' ','Enter']){fire('keydown',b,{key,repeat:false});eq(b.children[0].style.transform,'scale(.96)');fire('keydown',b,{key,repeat:true});eq(b.children.length,1);fire('keyup',b,{key});flush();eq(b.children.length,0)}
fire('keydown',b,{key:'ArrowLeft'});eq(b.children.length,0);fire('pointerdown',b,{button:2});eq(b.children.length,0);fire('pointerdown',b,{isPrimary:false});eq(b.children.length,0);
b.disabled=true;fire('pointerdown',b);eq(b.children.length,0);b.disabled=false;b.attrs['aria-disabled']='true';fire('keydown',b,{key:'Enter'});eq(b.children.length,0);delete b.attrs['aria-disabled'];
fire('pointerdown',b);b.disabled=true;mutation([]);eq(b.children.length,0);b.disabled=false;
fire('pointerdown',b);win.blur.forEach(f=>f());eq(b.children.length,0);fire('pointerdown',b);document.hidden=true;fire('visibilitychange',b);eq(b.children.length,0);document.hidden=false;
const dynamic=new Node;fire('pointerdown',dynamic);eq(dynamic.children.length,1);dynamic.isConnected=false;mutation([]);eq(dynamic.children.length,0);
fire('pointerdown',b);mutation([{type:'childList',target:b,addedNodes:[new Node('text')],removedNodes:[]}]);eq(b.children.length,0);
fire('pointerdown',b);fire('pointerup',b);fire('pointerdown',b);flush();eq(b.children.length,1);fire('pointercancel',b);eq(b.children.length,0);
reduced=true;fire('pointerdown',b);eq(b.children[0].style.transform,'scale(.96)');fire('pointerup',b);eq(b.children.length,0);
const input=new Node('input');fire('pointerdown',input);eq(input.children.length,0);
const js=fs.readFileSync(__dirname+'/press-feedback.js','utf8'),css=fs.readFileSync(__dirname+'/press-feedback.css','utf8');/* Test this screen's renderer: home also has unrelated card-surface handling. */ok(!js.includes('preventDefault'));ok(!js.includes('setPointerCapture'));ok(css.includes('100ms ease-out'));ok(css.includes('prefers-reduced-motion:reduce'));ok(!css.includes(':hover'));ok(!css.includes('brightness'));ok(css.includes('pointer-events:none!important'));
console.log(`${count} press feedback assertions passed (mock lifecycle and geometry contracts; no browser QA)`);

// Supplemental disabled state coverage; the preceding 55 assertions are the unchanged regression suite.
const baseline=count;reduced=false;
for(const key of [' ','Enter']){b.disabled=true;fire('keydown',b,{key,repeat:false});eq(b.children.length,0);fire('keyup',b,{key});eq(b.children.length,0)}
b.disabled=false;fire('pointerdown',b);eq(b.children[0].style.opacity,'1');b.disabled=true;mutation([{type:'attributes',target:b,attributeName:'disabled'}]);eq(b.children.length,0);ok(!b.className.includes('press-rendering'));fire('pointerup',b);flush();eq(b.children.length,0);
b.disabled=false;fire('pointerdown',b);eq(b.children.length,1);eq(b.children[0].style.transform,'scale(.96)');fire('pointercancel',b);eq(b.children.length,0);
console.log(`${count-baseline} supplemental disabled lifecycle assertions passed (mock DOM only)`);
