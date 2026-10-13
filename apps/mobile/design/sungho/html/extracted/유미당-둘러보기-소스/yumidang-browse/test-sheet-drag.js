const fs=require('fs'),assert=require('assert'),{environment}=require('./test-motion.js');let n=0;const ok=x=>{assert.ok(x);n++};
function setup(motion=true){const e=environment(false,motion);e.filterButtons[0].onclick();e.flushFrames();return e}
function touch(area,type,y,id=1,target=area,x=20){const t={clientX:x,clientY:y,identifier:id};let prevented=false;area.dispatch(type,{target,touches:type==='touchend'?[]:[t],changedTouches:[t],cancelable:true,preventDefault(){prevented=true}});return prevented}
let e=setup(),d=e.node('#filters'),body=e.node('.sheet-body'),h=e.node('#close-filters');
touch(body,'touchstart',100);ok(touch(body,'touchmove',190));ok(d.classList.contains('sheet-dragging'));touch(body,'touchend',190);ok(d.open&&d.inert);e.tick(200);ok(!d.open);
e=setup();d=e.node('#filters');body=e.node('.sheet-body');touch(body,'touchstart',100);touch(body,'touchmove',145);touch(body,'touchend',145);ok(d.open&&!d.inert);ok(!d.classList.contains('sheet-dragging'));ok(d.classList.contains('sheet-returning'));
// Normal reading scroll and reaching the bottom must never dismiss.
for(const top of [1,350,2000]){body.scrollTop=top;touch(body,'touchstart',100);ok(!touch(body,'touchmove',220));touch(body,'touchend',220);ok(d.open&&!d.inert)}
body.scrollTop=0;touch(body,'touchstart',200);ok(!touch(body,'touchmove',90));touch(body,'touchend',90);ok(d.open);
const control={closest:()=>({})};touch(body,'touchstart',100,1,control);ok(!touch(body,'touchmove',220,1,control));touch(body,'touchend',220,1,control);ok(d.open);
touch(body,'touchstart',100);touch(body,'touchmove',210);body.dispatch('touchcancel');ok(!d.classList.contains('sheet-dragging')&&d.open);
touch(body,'touchstart',100);ok(!touch(body,'touchmove',130,1,body,160));touch(body,'touchend',130);ok(d.open);
h=e.node('#close-filters');body.scrollTop=200;touch(h,'touchstart',100);touch(h,'touchmove',200);touch(h,'touchend',200);ok(d.inert);e.tick(200);ok(!d.open);
// Handle is a native keyboard close button; reduced motion closes immediately.
e=setup(false);h=e.node('#close-filters');h.onclick({detail:0});ok(!e.node('#filters').open&&e.timers.size===0);
e=setup(false);h=e.node('#close-filters');touch(h,'touchstart',100);touch(h,'touchmove',185);touch(h,'touchend',185);ok(!e.node('#filters').open&&e.timers.size===0);
const html=fs.readFileSync(__dirname+'/index.html','utf8');ok(!html.includes('>×</button></header>'));ok(html.includes('type="button" class="sheet-handle" id="close-filters" aria-label="필터 닫기"'));ok(html.includes('id="filter-error" role="alert"'));
console.log(n+' sheet pull-dismiss source/mock checks passed; real touch/browser QA not performed.');
