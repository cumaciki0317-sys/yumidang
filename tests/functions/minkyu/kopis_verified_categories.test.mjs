import test from 'node:test';
import assert from 'node:assert/strict';
import { KOPIS_RANKING_CATEGORIES, verifyKopisOfficialRanking, publicKopisRanking, parseKopisRankingXml, kopisRankingPeriod } from '../../../backend/supabase/functions/_shared/integrations/events/kopis-ranking.ts';
const now = new Date('2026-10-20T00:00:00Z');
const period = kopisRankingPeriod(now);
const xml = '<boxofs><boxof><rnum>1</rnum><mt20id>PF1</mt20id><cate>뮤지컬</cate><prfnm>공연</prfnm><prfpd>2026.10.01~2026.11.01</prfpd><prfplcnm>극장</prfplcnm><area>서울</area></boxof></boxofs>';
const evidence = () => ({ mode: 'musical', period, checkedAt: now.toISOString(), officialUrl: 'https://www.kopis.or.kr/por/boxoffice/boxoffice.do', officialCondition: '뮤지컬', order: 'official_display', items: [{sourceId:'PF1',rank:1}] });
test('14 categories keep genre and special conditions distinct', () => {
 assert.equal(Object.keys(KOPIS_RANKING_CATEGORIES).length,14);
 assert.equal(KOPIS_RANKING_CATEGORIES.classical.label,'클래식');
 assert.equal(KOPIS_RANKING_CATEGORIES.daehakro.kind,'region');
 assert.equal(KOPIS_RANKING_CATEGORIES.children.kind,'characteristic');
});
test('missing basedate can publish only after exact official comparison', () => {
 assert.throws(()=>parseKopisRankingXml(xml,'musical',period,now));
 const snapshot=verifyKopisOfficialRanking(xml,'musical',period,now,evidence());
 const out=publicKopisRanking(snapshot,'musical',now);
 assert.equal(out.status,'available'); assert.deepEqual(out.period,period);
 assert.equal(snapshot.apiPeriodVerified,false);
 assert.equal(out.checkedAt,now.toISOString());
});
test('mismatched category, period, id, order and unsafe URLs fail closed', () => {
 for(const changed of [ {mode:'all'}, {period:{...period,end:'2026-10-18'}}, {items:[{sourceId:'PF2',rank:1}]}, {officialCondition:'연극'}, {order:'sales_inferred'}, {officialUrl:'https://evil.example/'}, {officialUrl:'https://www.kopis.or.kr/openApi/restful?service=secret'} ]) {
  assert.throws(()=>verifyKopisOfficialRanking(xml,'musical',period,now,{...evidence(),...changed}));
 }
});
test('unverified rows never publish and category failure preserves last verified dates', () => {
 const old=verifyKopisOfficialRanking(xml,'musical',period,now,evidence());
 const next=new Date('2026-10-21T00:00:00Z');
 const delayed=publicKopisRanking(old,'musical',next);
 assert.equal(delayed.status,'available'); assert.equal(delayed.refreshDelayed,true); assert.deepEqual(delayed.period,period);
 assert.equal(publicKopisRanking(old,'all',next).status,'unavailable');
 const raw=parseKopisRankingXml(xml.replace('<boxofs>',`<boxofs><basedate>${period.start}~${period.end}</basedate>`),'musical',period,now);
 assert.equal(publicKopisRanking(raw,'musical',now).status,'unavailable');
 assert.match(publicKopisRanking(null,'all',now).officialUrl,/kopis.or.kr/);
});
test('official tied ranks preserve input order and sparse lists', () => {
 const tied=xml.replace('</boxofs>',xml.slice(8,-9).replaceAll('PF1','PF2')+'</boxofs>');
 const verified=verifyKopisOfficialRanking(tied,'musical',period,now,{...evidence(),items:[{sourceId:'PF1',rank:1},{sourceId:'PF2',rank:1}]});
 assert.deepEqual(verified.items.map(x=>x.sourceId),['PF1','PF2']);
 assert.deepEqual(verified.items.map(x=>x.rank),[1,1]);
});
test('every category is independently compared without inferring genre for special categories', () => {
 for(const [mode,category] of Object.entries(KOPIS_RANKING_CATEGORIES)) {
  const genre=category.kind==='genre'?category.label:'뮤지컬';
  const verified=verifyKopisOfficialRanking(xml.replace('<cate>뮤지컬</cate>',`<cate>${genre}</cate>`),mode,period,now,{...evidence(),mode,officialCondition:category.label});
  assert.equal(publicKopisRanking(verified,mode,now).status,'available');
 }
});
test('cloned assertions and mutated rows cannot obtain publication capability', () => {
 const verified=verifyKopisOfficialRanking(xml,'musical',period,now,evidence());
 assert.throws(()=>{verified.items[0].sourceId='PF2';},TypeError);
 assert.equal(publicKopisRanking(structuredClone(verified),'musical',now).status,'unavailable');
});
