const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const code=fs.readFileSync(__dirname+'/home-state.js','utf8');
function env(search=''){
 const nodes=new Map(),listeners={},notices=[];
 function node(id){if(nodes.has(id))return nodes.get(id);const n={id,hidden:false,disabled:false,checked:false,children:[],attrs:{},listeners:{},value:'',classList:{toggle(){}},addEventListener(k,f){(this.listeners[k]??=[]).push(f)},emit(k,e={}){for(const f of this.listeners[k]||[])f({currentTarget:this,...e})},setAttribute(k,v){this.attrs[k]=v},getAttribute(k){return this.attrs[k]},removeAttribute(k){delete this.attrs[k]},replaceChildren(...c){this.children=c},append(c){this.children.push(c)},focus(){},click(){this.onclick?.();this.emit('click')}};nodes.set(id,n);return n;}
 const radios=['guest','empty','booked','ongoing'].map(value=>Object.assign(node(value),{value}));
 node('appointment-template').content={cloneNode:()=>({querySelector:node})};
 const location={search,pathname:'/유미당-홈-소스/유미당-홈.html',href:''};
 vm.runInNewContext(code,{URLSearchParams,location,sessionStorage:{setItem(){}},alert(message){notices.push(message)},document:{getElementById:node,querySelector:node,querySelectorAll:()=>radios,addEventListener(k,f){listeners[k]=f}}});
 return {node,location,notices,switchTo(value){radios.forEach(r=>r.checked=r.value===value);node(value).emit('change')}};
}
const e=env(),n=e.node;
function guest(){assert.equal(n('private-slot').children.length,0);assert.equal(n('account-name').textContent,'');assert(n('account-profile').hidden);assert.equal(n('account-avatar').getAttribute('src'),undefined);assert(n('notification-button').hidden);assert(n('appointment-all').hidden);assert(!n('placeholder-cta').hidden);assert(!n('placeholder-cta').disabled);assert.equal(n('placeholder-cta').textContent,'네이버로 로그인 ›');}
guest();n('placeholder-cta').click();assert(e.notices.at(-1).includes('S05'));
for(let i=0;i<30;i++){
 e.switchTo('empty');assert(!n('appointment-all').hidden);assert.equal(n('private-slot').children.length,0);assert(!n('placeholder-cta').hidden);assert.equal(n('placeholder-cta').textContent,'동행 둘러보기 ›');assert.equal(n('account-name').textContent,'이민정');assert(!n('notification-button').hidden);
 e.switchTo('booked');assert(n('appointment-placeholder').hidden);assert.equal(n('private-slot').children.length,1);assert.equal(n('[data-dday-label]').textContent,'D-3');assert.equal(n('[data-companion-name]').textContent,'유지민');
 e.switchTo('guest');guest();
}
e.switchTo('empty');n('placeholder-cta').click();assert(e.notices.at(-1).includes('S01'));n('appointment-all').click();assert(e.notices.at(-1).includes('S13/activity'));
e.switchTo('ongoing');assert.equal(n('[data-dday-label]').textContent,'진행 중');assert.equal(n('[data-companion-status]').textContent,' 님과 동행 중');
n('demo-unread').checked=false;n('demo-unread').emit('change');assert(n('notification-dot').hidden);
n('demo-unread').checked=true;n('demo-unread').emit('change');assert(!n('notification-dot').hidden);
n('demo-events').value='empty';n('demo-events').emit('change');assert(n('event-carousel').hidden);assert(!n('event-placeholder-action').hidden);n('event-placeholder-action').click();assert(e.notices.at(-1).includes('S09-2'));
n('demo-events').value='error';n('demo-events').emit('change');assert.equal(n('event-placeholder-title').textContent,'행사를 불러오지 못했어요');n('event-placeholder-action').click();assert(n('event-carousel').hidden);assert(e.notices.at(-1).includes('재시도'));
for(const banned of ['location.href','location.assign','sessionStorage','localStorage','URLSearchParams'])assert(!code.includes(banned));
// Approved common navigation: 48px height, 12px bottom gap plus safe area. This is a source contract, not rendered geometry.
const html=fs.readFileSync(__dirname+'/index.html','utf8');const nav=html.match(/\.app-dock \.nav\{position:absolute;[^}]*\}/)?.[0];assert(nav);assert(nav.includes('height:48px'));assert(nav.includes('bottom:calc(12px + var(--safe-bottom,env(safe-area-inset-bottom,0px)))'));
assert.equal((html.match(/<button type="button" class="event-card"/g)||[]).length,5);assert(html.includes('data-press-surface="true"'));
console.log('PASS home guest/empty/booked/ongoing ×30, guest personal data removal, unread states, CTA event notices, fixed retry scene, no routing/storage and approved 48px/12px navigation source contract. Mock DOM only.');
