// Reuse lifecycle harness, then verify renderer identity and fractional source bounds.
const base=require('fs').readFileSync(__dirname+'/test-press-feedback.js','utf8');
new Function('require','__dirname',base+`\n{
 const source=fs.readFileSync(__dirname+'/index.html','utf8');
 for(const name of ['login','bell','all-events','appointment-more','category','women','robot','add'])ok(source.includes('class="'+name));
 // These controls use browser button content centering; an arbitrary span is not equivalent.
 for(const variant of [
  {name:'login',display:'inline-block',position:'absolute',width:'158px',height:'76px',fontSize:'30px',lineHeight:'normal'},
  {name:'bell',display:'inline-block',position:'absolute',width:'53px',height:'53px',lineHeight:'normal'},
  {name:'all-events',display:'inline-block',position:'absolute',width:'143.4375px',height:'36.5px',lineHeight:'normal'},
  {name:'appointment-more',display:'block',position:'static',width:'228.625px',height:'32px',lineHeight:'32px'},
  {name:'nav',display:'flex',position:'static',width:'222.5px',height:'116px',alignItems:'center',justifyContent:'center'},
  {name:'chip',display:'inline-flex',position:'relative',width:'110.6875px',height:'42px',alignItems:'center'}
 ]){
  const b=new Node;b.className=variant.name;b.style.position=variant.position==='static'?'':'absolute';b.style.top='145px';b.style.left='769px';
  context.getComputedStyle=()=>{const values={...variant,boxSizing:'border-box',borderLeftWidth:'1px',borderTopWidth:'1px'};const c=Object.keys(values);Object.assign(c,values,{getPropertyValue:p=>values[p]});return c};
  reduced=false;fire('pointerdown',b);const visual=b.children[0];eq(visual.tag,'button');eq(visual.type,'button');eq(visual.tabIndex,-1);eq(visual.inert,true);eq(visual.style.width,variant.width);eq(visual.style.height,variant.height);eq(visual.style.display,variant.display);eq(b.style.top,'145px');eq(b.style.left,'769px');eq(b.style.transform,undefined);fire('pointercancel',b);eq(b.children.length,0);
 }
 // The old offsetWidth rounding must not shrink a fractional label box and wrap its chevron.
 ok(js.includes("width:extent('width')"));ok(!js.includes("createElement('span')"));
 console.log('Native visual identity and 6 source-style geometry variants passed; this is not browser layout verification.');
}\n`)(require,__dirname);
