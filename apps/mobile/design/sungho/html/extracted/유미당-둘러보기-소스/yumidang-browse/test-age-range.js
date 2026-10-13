// Contracts and event simulation only. No browser or assistive technology QA.
const {environment}=require('./test-ui');
const assert=require('node:assert/strict'),fs=require('node:fs');let checks=0;
function eq(actual,expected){assert.equal(actual,expected);checks++}
let e=environment();const n=s=>e.node(s),open=()=>e.filterButtons[3].onclick();
const values=(a,b)=>{eq(Number(n('#age-min').value),a);eq(Number(n('#age-max').value),b)};
const input=(key,value)=>n('#age-'+key).oninput({target:{value}});
const key=(which,key)=>{let prevented=false;n('#age-'+which).onkeydown({key,preventDefault(){prevented=true}});eq(prevented,true)};
open();values(19,99);eq(n('#age-slider').style['--age-min'],'0%');eq(n('#age-slider').style['--age-max'],'100%');
n('#age-range').onclick();input('min',27);values(27,99);eq(n('#count').textContent,3);eq(n('#apply-filters').textContent,'적용하기 (3건)');
input('max',31);input('min',80);values(31,31);eq(n('#age-min').attributes['aria-valuemax'],'31');eq(n('#age-max').attributes['aria-valuemin'],'31');
input('max',19);values(31,31);input('min',-2);values(19,31);input('max',150);values(19,99);
key('min','End');values(99,99);key('min','ArrowLeft');values(98,99);key('max','Home');values(98,98);key('min','Home');values(19,98);key('max','End');values(19,99);
key('min','PageUp');values(29,99);key('max','PageDown');values(29,89);
n('#apply-filters').onclick();eq(n('#count').textContent,3);open();values(29,89);
n('#reset-filters').onclick();values(19,99);eq(n('#count').textContent,3);n('#close-filters').onclick();open();values(29,89);
n('#age-all').onclick();values(29,89);eq(n('#age-all').attributes['aria-pressed'],'true');
n('#age-range').onclick();eq(n('#age-range').attributes['aria-pressed'],'true');
input('min',59);input('max',59);
const pointer=(event,x,id=1)=>n('#age-slider').dispatch(event,{clientX:x,pointerId:id,button:0,isPrimary:true});
// Mock geometry is 600px wide: 19->x22, 59->x300, 99->x578.
pointer('pointerdown',290);eq(e.document.activeElement,n('#age-min'));pointer('pointermove',200);pointer('pointerup',200);eq(Number(n('#age-max').value),59);assert.ok(Number(n('#age-min').value)<59);checks++;
input('min',59);pointer('pointerdown',310);eq(e.document.activeElement,n('#age-max'));pointer('pointermove',400);pointer('pointercancel',400);const stopped=Number(n('#age-max').value);pointer('pointermove',500);eq(Number(n('#age-max').value),stopped);assert.ok(stopped>59);checks++;
input('min',19);input('max',19);pointer('pointerdown',30);pointer('pointermove',100);pointer('pointerup',100);assert.ok(Number(n('#age-max').value)>19);checks++;
input('max',99);input('min',99);pointer('pointerdown',570);pointer('pointermove',500);pointer('pointerup',500);assert.ok(Number(n('#age-min').value)<99);checks++;
pointer('pointerdown',400);n('#reset-filters').onclick();pointer('pointermove',100);values(19,99);
e=environment(true);open();input('min',50);n('#age-range').onclick();key('max','ArrowLeft');pointer('pointerdown',200);values(19,99);eq(n('#age-all').attributes['aria-pressed'],'true');eq(n('#age-slider').attributes['data-disabled'],'true');
const html=fs.readFileSync(__dirname+'/index.html','utf8'),css=fs.readFileSync(__dirname+'/browse.css','utf8');
eq((html.match(/class="age-track"/g)||[]).length,1);eq((html.match(/type="range"/g)||[]).length,2);
for(const which of ['min','max']){assert.ok(html.includes('id="age-'+which+'" aria-label='));assert.ok(!html.includes('for="age-'+which+'"'));checks+=2}
assert.ok(css.includes('height:48px'));assert.ok(css.includes('opacity:0;pointer-events:none'));assert.ok(css.includes('#age-min:focus-visible~.age-thumb-min'));assert.ok(css.includes('#age-max:focus-visible~.age-thumb-max'));checks+=4;
console.log(checks+' dual-range assertions passed (mock pointer/keyboard, bounds, equal handles, draft lifecycle, guest and accessibility contracts; no browser QA)');
fs.writeFileSync(__dirname+'/age-range-validation.json',JSON.stringify({assertions:checks,one_visible_track:true,two_semantic_inputs:true,age_bounds:[19,99],browser_visual_qa:false,native_touch_qa:false,assistive_technology_qa:false},null,2)+'\n');
