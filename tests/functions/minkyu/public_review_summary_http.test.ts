import {test}from 'node:test';import assert from 'node:assert/strict';
import {getVisibleSummary}from '../../../backend/supabase/functions/_shared/db/repositories/reviews.ts';
import {resolveRouteForMethod}from '../../../backend/supabase/functions/service-api/routes.ts';
const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const summary={summaryId:id,text:'공개 요약',sourceCount:3,updatedAt:'2026-10-06T01:00:00Z'};
test('공개 요약 회원 GET 경로·타입과 DB 권한 기준',async()=>{const calls:unknown[]=[];const db={rpc:async(name:string,args:unknown)=>{calls.push({name,args});return{summary};}};assert.deepEqual(await getVisibleSummary(db,id),{summary});assert.deepEqual(calls,[{name:'get_visible_review_summary',args:{p_profile_id:id}}]);const route=resolveRouteForMethod(new URL('https://example.test/service-api/profiles/'+id+'/review-summary'),'GET');assert.equal(route.internal,false);assert.equal(route.method,'GET');assert.throws(()=>resolveRouteForMethod(new URL('https://example.test/service-api/profiles/'+id+'/review-summary'),'POST'));});
test('근거2개/원문·직원 필드/301자 응답 거절, 비공개는 null',async()=>{assert.deepEqual(await getVisibleSummary({rpc:async()=>({summary:null})},id),{summary:null});for(const v of[{...summary,sourceCount:2},{...summary,evidenceIds:[id]},{...summary,text:'가'.repeat(301)}])await assert.rejects(getVisibleSummary({rpc:async()=>({summary:v})},id));});
