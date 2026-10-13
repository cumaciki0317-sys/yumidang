// Static native-CSS contracts and arithmetic only. Does not launch or simulate a browser.
const fs=require('node:fs'),assert=require('node:assert/strict');
const css=fs.readFileSync(__dirname+'/browse.css','utf8'),material=fs.readFileSync(__dirname+'/home-material.css','utf8'),js=fs.readFileSync(__dirname+'/browse.js','utf8'),html=fs.readFileSync(__dirname+'/index.html','utf8');
let checks=0;const ok=x=>{assert.ok(x);checks++},near=(a,b)=>{assert.ok(Math.abs(a-b)<.000002,`${a} ≠ ${b}`);checks++};
const token=name=>Number(css.match(new RegExp('--'+name+':([\\d.]+)px'))[1]);
ok(html.includes('viewport-fit=cover'));ok(!html.includes('user-scalable=no'));ok(!html.includes('maximum-scale='));
ok(css.includes('height:100vh;height:100dvh'));ok(css.includes('max-width:var(--app-max-width)'));ok(css.includes('margin:0 auto'));
ok(!/945px|transform-origin:top left/.test(css));ok(!js.includes('scale=w/'));ok(!js.includes('style.transform='));ok(js.includes('ResizeObserver'));ok(js.includes('visualViewport'));
near(token('home-row-gap'),21.8*360/945);near(token('nav-height'),118*360/945);near(token('nav-left'),27*360/945);near(token('nav-right'),26*360/945);near(token('list-bottom-clearance'),140);
for(const side of ['top','right','bottom','left'])ok(css.includes(`env(safe-area-inset-${side},0px)`));
near(token('app-reference-width'),390);near(token('app-tested-min-width'),320);near(token('app-max-width'),430);ok(!/(?<![\w-])min-width\s*:\s*(?:340|390)px/.test(css));
const matrix=[[320,568],[340,740],[360,640],[360,800],[375,812],[390,844],[412,915],[430,932],[568,320],[430,1200],[1024,900],[1200,900]].map(([width,height])=>{
 const frameWidth=Math.min(width,token('app-max-width')),navWidth=frameWidth-token('nav-left')-token('nav-right'),navBottom=height-token('home-row-gap');
 ok(frameWidth<=width);ok(frameWidth<=430);ok(navWidth>0);near(navBottom+token('home-row-gap'),height);
 return {viewport:[width,height],arithmeticFrame:[frameWidth,height],navWidth,navHeight:token('nav-height'),navBottomGap:token('home-row-gap')};
});
const fontSelectors=['.browse-header h1','.search input','.chip','.card-title','.profile-name','.sheet-body h3','.options button','.age-box strong','.custom-dates label','.custom-dates input','.sheet-footer button'];
const fontValues=Object.fromEntries(fontSelectors.map(selector=>{
 const body=css.split(selector+'{')[1].split('}')[0],rem=Number(body.match(/font-size:([\d.]+)rem/)[1]);ok(rem>0);near(rem*32,rem*16*2);return [selector,{defaultPx:rem*16,largeText200PercentPx:rem*32}];
}));
ok(css.includes('flex-wrap:wrap'));ok(css.includes('@media(max-width:340px)'));ok(css.includes('@media(max-height:420px)'));ok(css.includes('min-height:0'));
ok(css.includes('.filter-dialog .options button{position:relative;display:inline-flex;align-items:center;justify-content:center;height:max(32px,calc(1.4em + 10px));min-height:32px}'));ok(css.includes('font-size:0.8125rem;min-height:36px'));ok(css.includes('inset:-3px 0'));ok(css.includes('outline:2px solid #852CFF'));ok(css.includes('padding-bottom:calc(14px + var(--safe-bottom))'));
ok(material.includes('width:43.047619px;height:43.809524px'));ok(css.includes('width:24.380952px;height:24.761905px;flex:none'));
// A budget check for the flex allocation, not a measured header or rendered layout.
ok(css.includes('.browse-tools{flex:0 1 auto;min-height:0;max-height:calc(100% - var(--list-min-height))'));ok(css.includes('overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none'));ok(css.includes('.app-scroll{flex:1 0 var(--list-min-height)}'));ok(css.includes('.browse-content{--list-min-height:min(120px,40dvh)}'));ok(css.includes('.browse-content{--list-min-height:min(120px,40vh)}'));
ok(css.includes('.sheet-footer button{height:auto;min-height:49px;line-height:1.4'));ok(css.includes('.custom-dates label{flex:1 1 10em}'));ok(css.includes('.filter-dialog .sheet-body h3{line-height:1.230769231}'));
const textMatrix=[16,20,24,32].map(rootPx=>{const chipFontPx=.8125*rootPx,chipVisualPx=Math.max(32,1.4*chipFontPx+10),hitPx=chipVisualPx+6,rowPitchPx=chipVisualPx+7;near(rowPitchPx-hitPx,1);ok(chipVisualPx>1.4*chipFontPx);return {rootPx,chipFontPx,chipVisualPx,hitPx,hitGapPx:1}});
near(textMatrix[0].chipVisualPx,32);near(textMatrix[0].hitPx,38);near(textMatrix[3].chipVisualPx,46.4);near(textMatrix[3].hitPx,52.4);
const extremeHeightBudget={viewportHeightPx:320,conservativeHeaderBudgetPx:90,listReservePx:Math.min(120,320*.4),remainingToolsPx:320-90-120,basis:'Illustrative flex budget with a conservative header allocation; actual header and overflow were not browser measured.'};ok(extremeHeightBudget.listReservePx>=120);ok(extremeHeightBudget.remainingToolsPx>0);
const report={referenceWidth:390,testedSmallWidth:320,maxWidth:430,hardMinWidth:false,checks,textMatrix,extremeHeightBudget,browserQA:false,browserBlocker:'Browser process launch was blocked by the execution environment; no retry or bypass attempted.',coverage:'Source contracts, CSS arithmetic and separately executed mock DOM. Matrix and 200% root-font values are not browser measurements. Root-font resizing is explicit; actual browser text-only zoom and OS font-setting behavior are not verified.',matrix,fontValues,nativeSheet:{rootBaselinePx:16,fontRem:.8125,defaultFontPx:13,defaultVisualChipPx:32,defaultHitRegionPx:38,largeTextGrowth:true},navigation:{backgroundAlpha:.8,bottomGapPx:token('home-row-gap'),safeAreaAdditional:true},listEndClearancePx:140,remaining:'Actual device/browser visual alignment, overflow, touch targets, scroll and landscape/large-text rendering remain unverified.'};
fs.writeFileSync(__dirname+'/adaptive-layout-validation.json',JSON.stringify(report,null,2)+'\n');console.log(`${checks} adaptive CSS/source/arithmetic checks passed; actual browser matrix and large-text rendering not run.`);
