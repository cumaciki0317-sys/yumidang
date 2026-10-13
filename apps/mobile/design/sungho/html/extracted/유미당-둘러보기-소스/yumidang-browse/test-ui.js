// Event wiring tests with a minimal DOM harness. This is NOT browser rendering QA.
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
function environment(guest=false){
 const nodes=new Map();let document,context;
 function node(key){if(nodes.has(key))return nodes.get(key);const listeners={};const n={key,value:'',checked:false,hidden:false,disabled:false,dataset:{},style:{setProperty(k,v){this[k]=v}},textContent:'',innerHTML:'',scrollHeight:2400,scrollTop:0,classList:{toggle(){}},attributes:{},setAttribute(k,v){this.attributes[k]=String(v)},closest(){return null},focus(){document.activeElement=n},scrollIntoView(){},getBoundingClientRect(){if(key==='#viewport'){const width=Math.min(context.innerWidth,430),height=context.innerHeight,left=(context.innerWidth-width)/2;return {left,top:0,right:left+width,bottom:height,width,height}}return {left:0,top:100,right:600,bottom:900,width:600,height:800}},addEventListener(t,f){(listeners[t]??=[]).push(f)},dispatch(t,e={}){for(const f of listeners[t]??[])f({...e,target:e.target??n})},showModal(){n.open=true},close(){n.open=false;n.dispatch('close')}};nodes.set(key,n);return n}
 const filterButtons=['categories','regions','dates','ages','categories'].map((v,i)=>{let n=node('filter'+i);n.dataset.filter=v;return n});
 document={getElementById:id=>node('#'+id),documentElement:node('html'),querySelector:node,querySelectorAll:s=>s==='[data-filter]'?filterButtons:[],body:{style:{},classList:{toggle(){}}},fonts:{ready:Promise.resolve()},activeElement:node('initial')};
 node('#sort').value='newest';
 context={document,location:{search:guest?'?guest=1':''},URLSearchParams,structuredClone,innerWidth:390,innerHeight:844,addEventListener(){},requestAnimationFrame:f=>f(),module:{exports:{}},console};vm.runInNewContext(fs.readFileSync(__dirname+'/browse.js','utf8'),context);return {node,document,filterButtons,context};
}

let e=environment();assert.equal(e.node('#count').textContent,4);e.filterButtons[0].onclick();assert.equal(e.node('.app-scroll').style.overflowY,'hidden');
e.node('#filters').dispatch('click',{target:{closest:()=>({dataset:{group:'category',value:'전시'}})}});e.node('#apply-filters').onclick();assert.equal(e.node('#count').textContent,4);e.filterButtons[0].onclick();assert.ok(e.node('#category-options').innerHTML.includes('data-value="전시" class="selected"'));e.node('#close-filters').onclick();
e=environment(true);assert.ok(e.node('#cards').innerHTML.includes('동행인은 로그인 후 확인할 수 있어요'));assert.ok(!e.node('#cards').innerHTML.includes('김*미'));assert.equal(e.node('.bell').hidden,true);e.filterButtons[0].onclick();assert.equal(e.node('#age-range').disabled,true);
console.log('Design fixture / filter draft / guest mock checks passed.');module.exports={environment};
