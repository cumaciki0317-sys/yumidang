const assert=require('assert'),fs=require('fs'),{environment}=require('./test-event-environment.cjs');
for(const type of ['전체','전시','축제','팝업','공연','영화']){
 const e=environment();e.run(`setScenario('default');openEventFilters('event-admission')`);e.flush();e.choose('type',type);
 assert(!e.node('#filter-admission').hidden,type+' admission chip');assert(!e.node('#event-admission').hidden,type+' free section');assert(!e.node('#free').disabled);
 const before=e.node('#list').innerHTML,ranks=e.node('#ranks').innerHTML;
 e.node('#free').dispatch('change',{target:{checked:true}});assert(e.run('draft.free'));assert(!e.run('freeValue'));
 e.node('#apply-event-filters').onclick();e.tick(200);assert(e.run('freeValue'));assert(e.node('#filter-summary').textContent.includes('무료 입장'));assert(e.node('#filter-admission').classList.contains('selected'));assert.equal(e.node('#list').innerHTML,before);assert.equal(e.node('#ranks').innerHTML,ranks);
 e.run("openEventFilters('event-admission')");e.flush();assert(e.node('#free').checked);e.node('#free').dispatch('change',{target:{checked:false}});e.run('closeEventFilters()');e.tick(200);assert(e.run('freeValue'));
 e.run("openEventFilters('event-admission')");e.flush();e.node('#free').dispatch('change',{target:{checked:false}});e.node('#apply-event-filters').onclick();e.tick(200);assert(!e.run('freeValue'));assert(!e.node('#filter-summary').textContent.includes('무료 입장'));
}
const html=fs.readFileSync(__dirname+'/index.html','utf8');assert(html.includes('data-event-filter="event-admission"'));assert(html.includes('aria-controls="event-filters"'));assert(html.includes('<input type="checkbox" id="free">'));assert(!html.includes('유료만'));
console.log('PASS: free-admission visible and enabled in unified UI × six types; draft/apply/cancel/persist/off summary; unchanged fixed list and unchanged ranking. Source/mock only.');
