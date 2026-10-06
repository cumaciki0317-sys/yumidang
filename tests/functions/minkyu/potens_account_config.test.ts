import {test}from'node:test';
import assert from'node:assert/strict';
import{inspect}from'node:util';
import{loadPotensAccountPoolConfig}from'../../../backend/supabase/functions/_shared/config/env.ts';
import{toPublicError}from'../../../backend/supabase/functions/_shared/http/errors.ts';
const ids=['yumi','jonghyun','minkyu','sungho'];
const values:Record<string,string>={POTENS_ACCOUNT_ORDER:ids.join(','),POTENS_ACCOUNT_TOKEN_BUDGET:'3200000',POTENS_RESET_TIMEZONE:'Asia/Seoul',POTENS_MODEL:'claude-5-sonnet',...Object.fromEntries(ids.map(id=>['POTENS_API_KEY_'+id.toUpperCase(),'synthetic_private_'+id]))};
const load=(v:Record<string,string>)=>loadPotensAccountPoolConfig(k=>v[k]);
test('단일키 경로 유지·명시 다중 계정의 순서/합계와 immutable 설정',()=>{
 assert.equal(load({POTENS_API_KEY:'synthetic_legacy'}),null);const c=load(values)!;assert.deepEqual(c.accounts.map(a=>a.accountId),ids);assert.equal(c.globalDailyTokenBudget,12800000);assert.equal(c.resetTimezone,'Asia/Seoul');assert.ok(Object.isFrozen(c)&&Object.isFrozen(c.accounts)&&c.accounts.every(Object.isFrozen));assert.equal(c.accounts[0].apiKey,values.POTENS_API_KEY_YUMI);
});
test('일부 등록도 확정 순서를 유지하며 등록 계정만 전체 예산에 포함',()=>{
 const v={...values,POTENS_ACCOUNT_ORDER:'yumi,jonghyun',POTENS_API_KEY_MINKYU:'',POTENS_API_KEY_SUNGHO:''};assert.equal(load(v)!.globalDailyTokenBudget,6400000);
});
test('로그/JSON/spread로 비밀키를 노출하지 않는다',()=>{
 const c=load(values)!;for(const output of[JSON.stringify(c),inspect(c),JSON.stringify(c.accounts),inspect(c.accounts),JSON.stringify({...c.accounts[0]})])assert.equal(output.includes('synthetic_private_'),false);
});
test('누락·중복키·순서·모델·일자·예산 오류는 단일키 fallback 없이 거절',()=>{
 const invalid=[{POTENS_ACCOUNT_ORDER:'yumi,yumi'},{POTENS_ACCOUNT_ORDER:'sungho,yumi'},{POTENS_ACCOUNT_ORDER:'unknown'},{POTENS_API_KEY_YUMI:''},{POTENS_API_KEY_YUMI:values.POTENS_API_KEY_JONGHYUN},{POTENS_MODEL:'other'},{POTENS_RESET_TIMEZONE:'UTC'},{POTENS_ACCOUNT_TOKEN_BUDGET:'3200001'},{POTENS_ACCOUNT_TOKEN_BUDGET:'0'},{POTENS_API_KEY_YUMI:'secret\nprivate'}];
 for(const delta of invalid)assert.throws(()=>load({...values,POTENS_API_KEY:'legacy_should_not_fallback',...delta}),e=>{const safe=toPublicError(e);assert.equal(safe.error.code,'EXTERNAL_UNAVAILABLE');assert.equal(JSON.stringify(safe).includes('secret'),false);return true;});
 assert.throws(()=>load({POTENS_API_KEY_YUMI:'synthetic_private_yumi'}));assert.throws(()=>load({...values,POTENS_ACCOUNT_ORDER:'yumi'}));
});
