const fs=require('fs');
const base=fs.readFileSync(__dirname+'/test-press-feedback.js','utf8');
new Function('require','__dirname',base+`\n{
 reduced=false;
 const card=new Node;card.className='appointment-hit';card.attrs['data-press-surface']='true';card.style.position='absolute';
 const surface=new Node('span');surface.className='appointment glass appointment-action press-surface';Object.assign(surface.style,{transform:'',background:'original translucent gradients',color:'original text',opacity:'1',filter:'none',backdropFilter:'blur(10px) saturate(112%)'});card.append(surface);card.querySelector=selector=>selector==='.press-surface'?surface:null;
 const paint=()=>JSON.stringify({background:surface.style.background,color:surface.style.color,opacity:surface.style.opacity,filter:surface.style.filter,backdropFilter:surface.style.backdropFilter});const originalPaint=paint();
 const stable=()=>{eq(card.children.length,1);eq(card.children[0],surface);eq(surface.parentNode,card);eq(paint(),originalPaint);ok(!card.className.includes('press-rendering'));eq(card.style.transform,undefined)};
 for(let i=0;i<20;i++){fire('pointerdown',card);stable();eq(surface.style.transform,'scale(.96)');fire('pointermove',card,{clientX:200});eq(surface.style.transform,'scale(1)');fire('pointermove',card);eq(surface.style.transform,'scale(.96)');fire('pointerup',card);eq(surface.style.transform,'scale(1)');flush();eq(surface.style.transform,'');stable()}
 for(const type of ['pointercancel','lostpointercapture','focusout']){fire('pointerdown',card);fire(type,card);eq(surface.style.transform,'');stable()}
 for(const key of [' ','Enter']){fire('keydown',card,{key});eq(surface.style.transform,'scale(.96)');fire('keyup',card,{key});flush();stable();eq(surface.style.transform,'')}
 fire('pointerdown',card);card.disabled=true;mutation([]);eq(surface.style.transform,'');stable();fire('pointerdown',card);eq(surface.style.transform,'');card.disabled=false;
 fire('pointerdown',card);win.blur.forEach(f=>f());eq(surface.style.transform,'');stable();
 reduced=true;fire('pointerdown',card);fire('pointerup',card);eq(surface.style.transform,'');stable();
 const page=fs.readFileSync(__dirname+'/index.html','utf8'),extraCss=fs.readFileSync(__dirname+'/home-state.css','utf8');
 ok(page.includes('class="appointment-hit" data-press-surface="true"'));ok(extraCss.includes('left:16px;top:var(--home-appointment-card-top);width:328.380952381px;height:131.047619048px;'));ok(css.includes('button{-webkit-tap-highlight-color:transparent}'));ok(css.includes('.press-surface{pointer-events:none;transform-origin:center;transition:transform 100ms ease-out}'));
 reduced=false;const eventCard=new Node;eventCard.attrs['data-press-surface']='true';eventCard.attrs['data-event-id']='sample-autumn';const eventSurface=new Node('span');eventSurface.style.transform='';eventSurface.style.opacity='1';eventSurface.style.background='unchanged';eventCard.append(eventSurface);eventCard.querySelector=()=>eventSurface;
 fire('pointerdown',eventCard,{clientX:25,clientY:25});eq(eventSurface.style.transform,'scale(.96)');fire('pointermove',eventCard,{clientX:33,clientY:25});eq(eventSurface.style.transform,'scale(.96)');fire('pointermove',eventCard,{clientX:34,clientY:25});eq(eventSurface.style.transform,'');eq(eventCard.children.length,1);eq(eventCard.children[0],eventSurface);eq(eventSurface.style.background,'unchanged');eq(eventSurface.style.opacity,'1');fire('pointerup',eventCard);flush();eq(eventSurface.style.transform,'');
 fire('keydown',eventCard,{key:' '});eq(eventSurface.style.transform,'scale(.96)');fire('keyup',eventCard,{key:' '});flush();eq(eventSurface.style.transform,'');eq(eventCard.children.length,1);
 console.log(count+' combined press checks passed; persistent card paint identity and fixed hit area verified in mock DOM, not visual pixel comparison.');
}\n`)(require,__dirname);
