/* External preview adapter: existing controls and event bindings are retained. */
(() => {
 function setup(){
  const panel=document.querySelector('aside.demo-panel,aside#browse-review,aside.review-panel,aside.preview-controls,aside.preview-bar,aside.demo');
  if(!panel||panel.hidden||getComputedStyle(panel).display==='none'||panel.classList.contains('yd-preview-panel'))return;
  panel.classList.add('yd-preview-panel');panel.setAttribute('aria-label','화면 미리보기 조작 패널');
  const parent=panel.parentElement;parent.classList.add('yd-preview-layout');
  for(const n of panel.children){if(n.matches('h1,h2,.eyebrow,strong'))n.classList.add('yd-preview-old-heading');}
  const heading=document.createElement('header');heading.className='yd-preview-heading';
  const name=document.createElement('p');name.textContent=document.title.replace(/^유미당\s*[·・]?\s*/,'');
  const title=document.createElement('h2');title.textContent='화면 미리보기';heading.append(name,title);panel.prepend(heading);
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setup,{once:true});else setup();
})();
