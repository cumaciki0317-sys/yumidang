// Current policy + local prototype interaction tests. No real browser/service verification.
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const M=require('./detail-model'),R=require('./detail');let assertions=0;
function ok(value,label){assert.ok(value,label);assertions++;}
for(const [key]of M.scenarios){const v=M.getView(key),html=R.renderBody(v)+R.renderFooter(v);ok(html.length>50,key+' renders');if(!v.privateVisible){ok(!html.includes(M.fixture.address),key+' address excluded');ok(!html.includes(M.fixture.meeting),key+' meeting excluded');}if(!v.owner&&!v.privateVisible)ok(!html.includes(M.fixture.name),key+' full name excluded');}
const guest=R.renderBody(M.getView('guest'));
for(const value of [M.fixture.name,M.fixture.masked,'provided-profile','당도 15','만 29세'])ok(!guest.includes(value),'guest excludes '+value);
ok(guest.includes('동행인은 로그인 후 확인할 수 있어요')&&guest.includes('data-target="S05"'),'guest neutral login placeholder');
for(const key of ['confirmed','authorConfirmed','completed','disputed']){const h=R.renderBody(M.getView(key));ok(h.includes(M.fixture.address)&&h.includes(M.fixture.name),key+' participant visible');}
for(const key of ['ineligible','closed','expired','rejected','blocked','confirmedOther'])ok(M.getView(key).disabled,key+' cannot apply');
ok(!M.getView('closedChat').disabled,'existing chat preserved after close');
ok(!R.renderBody(M.getView('noevent')).includes('연결된 문화 행사'),'no event');
ok(M.getView('cooldown').disabled&&!M.getView('reapply').disabled,'cooldown separate clock scene');
class Node{constructor(id){this.id=id;this.style={setProperty(k,v){this[k]=v}};this.scrollTop=0;this.classList={toggle(){}};this.innerHTML='';this.hidden=false;this.handlers={};this.isConnected=true;this.open=false;this.dataset={};this.textContent='';}addEventListener(t,cb){(this.handlers[t]??=[]).push(cb);}emit(t,e={}){for(const cb of this.handlers[t]||[])cb(e);}setAttribute(k,v){this[k]=v;}focus(){doc.activeElement=this;}querySelector(){return new Node('cancel');}showModal(){this.open=true;}close(){this.open=false;this.emit('close');}closest(sel){return sel==='#app'?nodes['#app']:this;}getBoundingClientRect(){return {left:0,right:390,top:0,bottom:800,width:390,height:800};}}
const nodes={};for(const id of ['#app','#action-dialog','#detail-sheet','#review-feedback','#scenario','#detail-root','#detail-footer','#sheet-heading','.back-button','#header-actions','#dialog-content','#scrim','#reopen','#handle','#reset-demo'])nodes[id]=new Node(id);
const doc=new Node('document');doc.querySelector=s=>nodes[s]||(nodes[s]=new Node(s));doc.activeElement=nodes['#handle'];const intervals=[];
const context={document:doc,setInterval:f=>intervals.push(f),Date,console,addEventListener(){},dispatchEvent(){},CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail}}};context.globalThis=context;
vm.runInNewContext(fs.readFileSync(__dirname+'/detail-model.js','utf8'),context);vm.runInNewContext(fs.readFileSync(__dirname+'/shared/drag-scroll.js','utf8'),context);vm.runInNewContext(fs.readFileSync(__dirname+'/shared/bottom-sheet.js','utf8'),context);vm.runInNewContext(fs.readFileSync(__dirname+'/detail.js','utf8'),context);
function choose(k){nodes['#scenario'].emit('change',{target:{value:k}});}
function click(action,target){const b=new Node('button');b.dataset={action,target};b.textContent=action;b.disabled=false;doc.emit('click',{target:{closest:()=>b}});}
function body(){return nodes['#detail-root'].innerHTML;}

for(const action of ['confirm-close','confirm-request','confirm-reject','confirm-delete','reopen-recruitment']){choose('author');const before=body();click(action);ok(nodes['#scenario'].value==='author'&&body()===before,action+' retains selected design scene');}
choose('default');click('external','S11');ok(nodes['#review-feedback'].textContent.includes('S11'),'explicit route contract');
console.log(JSON.stringify({assertions,scenarios:M.scenarios.length,scope:'Synthetic render + mocked DOM actions; not browser/service execution'}));
