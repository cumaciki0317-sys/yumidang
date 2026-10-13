/* One natural-height budget. Existing width/text-dependent sizes are lower bounds. */
function homeHeightAllocation(available,natural){
 const budget=Math.max(0,Math.min(80,Math.floor((available-natural-1)*100)/100));
 const row=Math.floor(budget*.15*100)/100,sectionGap=Math.floor(budget*.2*100)/100;
 return {budget,row,sectionGap,used:row*4+sectionGap*2};
}
if(typeof module!=='undefined')module.exports={homeHeightAllocation};
if(typeof document!=='undefined')(()=>{
 const frame=document.getElementById('viewport'),screen=document.querySelector('.screen'),grid=document.querySelector('.categories'),banner=document.querySelector('.home-banner');
 let queued=false,lastFrame='';
 function update(){
  queued=false;
  const r=frame.getBoundingClientRect(),root=document.documentElement.style;
  for(const [name,value] of Object.entries({left:r.left,top:r.top,width:r.width,height:r.height,bottom:innerHeight-r.bottom,right:innerWidth-r.right}))root.setProperty('--frame-'+name,value+'px');
  // Clear only this feature's growth before reading the natural current layout.
  // No previously expanded size becomes a new minimum on the next frame.
  const style=screen.style;
  for(const name of ['--home-category-rows','--home-row-pad','--home-section-growth'])style.removeProperty(name);
  const cards=[...grid.querySelectorAll('.category')];
  const rows=[0,4,8,12].map(i=>Math.max(...cards.slice(i,i+4).map(c=>c.getBoundingClientRect().height)));
  const natural=banner.getBoundingClientRect().bottom-screen.getBoundingClientRect().top+parseFloat(getComputedStyle(screen).paddingBottom);
  const available=frame.clientHeight;
  const growth=homeHeightAllocation(available,natural);
  if(growth.used>0){
   style.setProperty('--home-category-rows',rows.map(h=>(h+growth.row)+'px').join(' '));
   style.setProperty('--home-row-pad',(growth.row/2)+'px');
   style.setProperty('--home-section-growth',growth.sectionGap+'px');
  }
  // Review/debug metrics only; never used as input to the next measurement.
  frame.dataset.heightNatural=natural.toFixed(3);frame.dataset.heightGrowth=growth.used.toFixed(3);
  frame.dataset.heightMode=growth.used>0?'expanded':natural>available?'scroll':'minimum';
 }
 function refresh(){if(queued)return;queued=true;requestAnimationFrame(update)}
 addEventListener('resize',refresh);
 if(typeof ResizeObserver==='function')new ResizeObserver(entries=>{
  const rect=entries[0].contentRect,key=rect.width+':'+rect.height;
  if(key!==lastFrame){lastFrame=key;refresh()}
 }).observe(frame);
 document.fonts.ready.then(refresh);document.fonts.addEventListener?.('loadingdone',refresh);
 window.visualViewport?.addEventListener('resize',refresh);
 window.YumidangHomeLayout=Object.freeze({refresh});
 refresh();
})();
