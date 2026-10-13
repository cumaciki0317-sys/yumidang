const assert=require('assert'),fs=require('fs'),{environment}=require('./test-event-environment.cjs');const e=environment();
assert.equal(e.run('results().length'),4);assert(!e.node('#filter-region').hidden);assert(!e.node('#event-regions').hidden);assert(!e.node('#genre-section').hidden);assert(!e.node('#filter-admission').hidden);assert(!e.node('#event-admission').hidden);assert(!e.node('#bell').hidden);assert(e.node('#ranks').innerHTML.includes('rank-item'));
e.run("setScenario('guest')");assert(e.node('#bell').hidden);assert(!e.node('#login').hidden);e.run("setScenario('pickerPast')");assert(e.node('#rank-section').hidden);assert(e.node('#list').innerHTML.includes('disabled'));assert(e.node('#ongoing').disabled);assert(!e.node('#period').hidden);
e.run("setScenario('default');openEventFilters('event-types')");e.flush();e.choose('type','공연');assert(!e.node('#genre-section').hidden);assert.equal(e.run('type'),'전체');e.node('#apply-event-filters').onclick();e.tick(200);assert.equal(e.run('type'),'공연');assert.equal(e.run('results().length'),4);
e.run("setScenario('default')");assert(!e.node('#filter-region').hidden);assert(!e.node('#filter-admission').hidden);assert(!e.node('#bell').hidden);assert.equal((e.node('#ranks').innerHTML.match(/rank-item/g)||[]).length,10);const ranks=e.node('#ranks').innerHTML;
e.run("openEventFilters('event-regions')");e.flush();assert.equal((e.node('#region').innerHTML.match(/<button/g)||[]).length,18);e.choose('region','제주');e.choose('region','부산');assert.equal(e.run('draft.region'),'부산');assert.equal((e.node('#region').innerHTML.match(/class="selected"/g)||[]).length,1);assert(!e.node('#genre-section').hidden);e.choose('type','공연');assert(!e.node('#genre-section').hidden);e.choose('genre','연극');assert.equal(e.run('draft.type'),'전체');assert.equal(e.run('draft.genre'),'연극');e.choose('type','전체');assert(!e.node('#genre-section').hidden);assert.equal(e.run('draft.genre'),'');e.choose('type','전시');assert.equal(e.run('draft.genre'),'');e.node('#free').dispatch('change',{target:{checked:true}});e.node('#apply-event-filters').onclick();e.tick(200);assert.equal(e.run('region'),'부산');assert(e.run('freeValue'));assert.equal(e.run('results().length'),4);assert.equal(e.node('#ranks').innerHTML,ranks);
e.run("setScenario('past')");assert(!e.node('#period').hidden);assert(e.node('#date-error').hidden);assert.equal(e.node('#from').value,'2026-08-01');assert(e.node('#ongoing').disabled);e.run("setScenario('invalidPeriod')");e.flush();assert(e.node('#event-filters').open);assert(!e.node('#date-error').hidden);assert.equal(e.node('#list').innerHTML,'');e.run("setScenario('picker')");e.tick(0);assert(e.node('#list').innerHTML.includes('이 행사 연결하기'));assert(e.node('#picker-note').textContent.includes('바뀌지'));
e.run("setScenario('more')");assert.equal((e.node('#list').innerHTML.match(/class="event-row"/g)||[]).length,10);e.clickMain('more');assert.equal((e.node('#list').innerHTML.match(/class="event-row"/g)||[]).length,16);e.run("setScenario('moreError')");e.clickMain('retry-page');assert.equal(e.run('state'),'pageError');
for(const state of ['default','guest','rankError','rankLoading','empty','error','taxonomyError','loading','picker','past','invalidPeriod','pickerPast','more','moreError','imageSample','imageMissing']){e.run(`setScenario('${state}')`);e.flush();assert(e.node('#title').textContent);}
const code=fs.readFileSync(__dirname+'/events.js','utf8'),sheet=fs.readFileSync(__dirname+'/events-sheet.js','utf8'),html=fs.readFileSync(__dirname+'/index.html','utf8');for(const bad of ['fetch(','localStorage','fee.startsWith'])assert(!(code+sheet).includes(bad));for(const bad of ['age-range','data-event-group="age"','id="search"','id="sort"','app-dock','id="ai"','id="create"'])assert(!html.includes(bad));
console.log('PASS: 16 unified scenario renders; preserved event cards/ranking, unified region controls, national+17 single regions, exclusive genres, fixed example data, past-date errors, paging, retry event notice and no new business/API controls.');

// Empty-state reset must clear every applied condition and match sheet reset defaults.
const reset=environment();
reset.run("setScenario('empty');type='공연';genre='뮤지컬';region='부산';past=true;ongoingValue=true;freeValue=true;fromValue='2026-08-01';toValue='2026-09-10';limit=20;render()");
reset.clickMain('reset');
assert.deepEqual(JSON.parse(reset.run('JSON.stringify(readEventSelection())')),JSON.parse(reset.run('JSON.stringify(eventDefaults())')));
assert.equal(reset.run('state'),'default');assert.equal(reset.node('#mode').value,'default');assert.equal(reset.run('limit'),10);
assert.equal(reset.node('#filter-summary').textContent,'전체 · 전체 유형 · 이번 주 신규');
assert.equal(reset.run('results().length'),4);assert(!reset.node('#ongoing').checked);assert(!reset.node('#free').checked);
reset.run("openEventFilters('event-types')");reset.flush();reset.choose('type','공연');reset.choose('genre','뮤지컬');reset.choose('region','제주');reset.choose('period','past');
reset.node('#reset-event-filters').onclick();reset.node('#apply-event-filters').onclick();reset.tick(200);
assert.deepEqual(JSON.parse(reset.run('JSON.stringify(readEventSelection())')),JSON.parse(reset.run('JSON.stringify(eventDefaults())')));
// Validate fixed fixture ordering, without introducing runtime business sorting.
const sets=JSON.parse(reset.run('JSON.stringify(DISPLAY_SETS)')),group={'진행 중':0,'예정':1,'종료':2};
for(const [name,rows] of Object.entries(sets))for(let i=1;i<rows.length;i++){
 const a=rows[i-1],b=rows[i];assert(group[a.statusLabel]<=group[b.statusLabel],name+' status order');
 if(a.statusLabel!==b.statusLabel)continue;
 const ad=a.periodLabel.split(' ~ '),bd=b.periodLabel.split(' ~ ');
 assert(a.statusLabel==='예정'?ad[0]<=bd[0]:a.statusLabel==='종료'?ad[1]>=bd[1]:ad[0]>=bd[0],name+' date order');
}
reset.run("setScenario('more')");const firstPage=reset.node('#list').innerHTML;assert(!firstPage.includes('새로운 시선'));
reset.clickMain('more');const allPages=reset.node('#list').innerHTML;assert(allPages.indexOf('더보기 검수용 행사 12')<allPages.indexOf('새로운 시선'));
console.log('PASS: empty-state and sheet reset share defaults; all fixed examples and paging preserve status/date order.');

e.run("setScenario('default')");assert(!html.includes('id="branch"'));assert(e.node('#list').innerHTML.includes('연결 공고 없음'));assert(e.node('#list').innerHTML.includes('동행 공고 1건 보기'));assert(e.node('#list').innerHTML.includes('삼청 전시관'));assert(e.node('#list').innerHTML.includes('무료'));assert(e.node('#list').innerHTML.includes('image-fallback'));assert(!e.node('#list').innerHTML.includes('class="event-photo"'));
e.run("setScenario('imageSample')");assert(e.node('#list').innerHTML.includes('class="event-photo"'));assert(e.node('#list').innerHTML.includes('샘플 이미지'));assert(e.node('#list').innerHTML.includes('onerror='));e.run("setScenario('imageMissing')");assert(!e.node('#list').innerHTML.includes('class="event-photo"'));console.log('PASS: unified metadata, related counts and image-present/missing fallback markup.');
