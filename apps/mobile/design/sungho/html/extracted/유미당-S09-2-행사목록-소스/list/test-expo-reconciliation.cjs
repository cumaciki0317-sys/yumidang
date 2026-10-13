const fs=require('fs'),assert=require('assert'),{environment}=require('./test-event-environment.cjs');
const e=environment();
for(const scene of ['default','ongoing','guest','rankError','rankLoading','empty','error','taxonomyError','loading','picker','past','invalidPeriod','pickerPast','more','moreError','imageSample','imageMissing','longText']){e.run(`setScenario('${scene}')`);e.flush();assert(e.node('#title').textContent);if(scene==='invalidPeriod')assert(!e.node('#date-error').hidden);if(scene==='error')assert(e.node('#list').innerHTML.includes('다시 시도'));if(scene==='empty')assert(e.node('#list').innerHTML.includes('조건에 맞는'))}
e.run("setScenario('default')");const before=e.run('JSON.stringify(results())');e.run("type='공연';genre='뮤지컬';region='제주';freeValue=true;past=true;ongoingValue=true");assert.equal(e.run('JSON.stringify(results())'),before);
e.run("setScenario('error')");e.clickMain('retry');assert.equal(e.run('state'),'error');
for(const name of ['events.js','events-sheet.js']){const code=fs.readFileSync(__dirname+'/'+name,'utf8');for(const banned of ['location.href','location.assign','sessionStorage','localStorage','Date.parse','validEventPeriod','fetch('])assert(!code.includes(banned),name+': '+banned)}
console.log('PASS 18 fixed scenes, date error/empty/retry markup, selections do not compute results, no router/storage/query engine.');
