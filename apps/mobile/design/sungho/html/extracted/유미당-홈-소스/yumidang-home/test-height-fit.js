const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');const {homeHeightAllocation:allocate}=require('./adaptive.js');const code=fs.readFileSync(__dirname+'/adaptive.js','utf8');
let checks=0;const ok=v=>{assert.ok(v);checks++};
const matrix=[];
for(const width of [320,360,390,430])for(const height of [568,667,800,844,932])for(const safe of [[0,0],[24,34]]){
 // Synthetic natural-layout inputs exercise wrapping/state/safe-area variation.
 // These are not claimed to be measured browser dimensions.
 const natural=808.7+({320:38,360:12,390:0,430:0}[width])+safe[0]+safe[1];
 const g=allocate(height,natural);ok(g.row>=0&&g.row<=12);ok(g.sectionGap>=0&&g.sectionGap<=16);ok(g.used<=80);ok(g.used<=Math.max(0,height-natural));if(natural>=height)ok(g.used===0);
 matrix.push({width,height,safe,natural_synthetic_input:natural,...g,mode:natural>height?'scroll':g.used?'expanded':'minimum'});
}
for(let natural=400;natural<=1200;natural+=.5)for(const height of [568,667,800,844,932,1200]){const g=allocate(height,natural);ok(g.row>=0&&g.sectionGap>=0);ok(g.used<=80+.00001);ok(g.used<=Math.max(0,height-natural)+.00001)}
// DOM geometry harness: remove previous growth before each measurement, reflow by width/state.
let height=932,natural=810,rowHeights=[54,55,54,56],cardHeight=136;const props={};let queued=[],roCallback,frameDimensions='';
const style={setProperty(k,v){props[k]=v},removeProperty(k){delete props[k]}};
const screen={style,getBoundingClientRect:()=>({top:0})},frame={dataset:{},get clientHeight(){return height},getBoundingClientRect:()=>({left:0,top:0,right:390,bottom:height,width:390,height})};
const grid={querySelectorAll:()=>Array.from({length:16},(_,i)=>({getBoundingClientRect:()=>({height:rowHeights[Math.floor(i/4)]})}))};
const banner={getBoundingClientRect:()=>({bottom:natural-61.257142857+(parseFloat(props['--home-section-growth'])||0)*2+(parseFloat(props['--home-row-pad'])||0)*8})};
const placeholder={hidden:false,getBoundingClientRect:()=>({height:cardHeight})};
const document={getElementById:id=>id==='viewport'?frame:placeholder,querySelector:s=>({'.screen':screen,'.categories':grid,'.home-banner':banner,'.appointment-hit':placeholder})[s],documentElement:{style:{setProperty(){}}},fonts:{ready:{then(){}},addEventListener(){}}};const window={};
vm.runInNewContext(code,{document,window,innerHeight:height,innerWidth:390,requestAnimationFrame:f=>queued.push(f),addEventListener(){},getComputedStyle:()=>({paddingBottom:'61.257142857px'}),ResizeObserver:class{constructor(f){roCallback=f}observe(){}}});
const flush=()=>{let count=0;while(queued.length){queued.shift()();if(++count>5)throw Error('frame loop')}return count};flush();
assert.equal(props['--home-card-min'],undefined);assert.equal(props['--home-section-growth'],'16px');assert.equal(props['--home-category-rows'],'66px 67px 66px 68px');assert.equal(frame.dataset.heightGrowth,'80.000');
window.YumidangHomeLayout.refresh();window.YumidangHomeLayout.refresh();assert.equal(flush(),1);assert.equal(props['--home-card-min'],undefined);assert.equal(props['--home-section-growth'],'16px'); // no repeated expansion
height=667;window.YumidangHomeLayout.refresh();flush();assert.equal(props['--home-card-min'],undefined);assert.equal(props['--home-category-rows'],undefined);assert.equal(frame.dataset.heightMode,'scroll');
height=932;natural=882;rowHeights=[70,72,70,74];cardHeight=170;placeholder.hidden=true;window.YumidangHomeLayout.refresh();flush();const growth=allocate(height,natural);assert.equal(props['--home-card-min'],undefined);assert.equal(props['--home-card-pad'],undefined);assert.equal(props['--home-section-growth'],growth.sectionGap+'px');assert.equal(props['--home-category-rows'],rowHeights.map(h=>(h+growth.row)+'px').join(' '));
roCallback([{contentRect:{width:390,height:932}}]);flush();roCallback([{contentRect:{width:390,height:932}}]);assert.equal(flush(),0);
const css=fs.readFileSync(__dirname+'/adaptive.css','utf8'),addition=css.split('/* Height growth has one budget.')[1].replace(/\/\*[\s\S]*?\*\//g,'');ok(!/font-size|\.category img|transform:|scale\(/.test(addition));ok(!code.includes('setInterval'));ok(code.includes('observe(frame)'));ok(!code.includes('observe(screen)'));ok(code.indexOf('style.removeProperty')<code.indexOf('const natural='));
fs.writeFileSync(__dirname+'/height-fit-validation.json',JSON.stringify({method:'pure budget arithmetic and synthetic DOM geometry; not browser layout',caps:{total:80,each_category_row:12,each_section_gap:16,appointment:0},matrix,checks,browser_qa:false,browser_blocker:'Chromium socket() Operation not permitted; no bypass attempted',invariants:['minimum is measured after clearing growth per width/state','single allocation, no repeated ResizeObserver growth','short viewport scrolls','fonts and icon dimensions unchanged','existing gaps/footer/safe areas included once','appointment height and padding never receive viewport growth']},null,2)+'\n');console.log(checks+' height-budget checks and resize/state feedback harness passed; '+matrix.length+' matrix cases, NOT browser measurements.');
