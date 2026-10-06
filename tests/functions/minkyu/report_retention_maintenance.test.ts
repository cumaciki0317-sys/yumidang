/** 단일 유지관리 batch의 전송·예산취소·불확실 결과 경계. DB/배포 성공은 별도. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadRuntimeConfig} from '../../../backend/supabase/functions/_shared/config/env.ts';
import {createReportRetentionMaintenancePort,ReportRetentionMaintenanceUnknown} from '../../../backend/supabase/functions/_shared/db/report-retention-client.ts';
import {toPublicError} from '../../../backend/supabase/functions/_shared/http/errors.ts';
const values:Record<string,string>={SUPABASE_URL:'https://fixture.example.test',SUPABASE_ANON_KEY:'fixture-anon',SUPABASE_SERVICE_ROLE_KEY:'fixture-service',INTERNAL_WORKER_SECRET:'fixture_worker_secret_longer_than_32_characters',ALLOWED_ORIGINS:'[]',MAX_REQUEST_BYTES:'8192',UPSTREAM_TIMEOUT_MS:'1000'};
const config=loadRuntimeConfig(k=>values[k]),token='11111111-1111-4111-8111-111111111111';
const code=(c:string)=>(e:unknown)=>toPublicError(e).error.code===c;
test('exact RPC·서비스 JWT·원 토큰/한도 전달, 단일 호출과 frozen 결과',async()=>{
 let calls=0;const port=createReportRetentionMaintenancePort(config,async(url,init)=>{calls++;assert.equal(String(url),values.SUPABASE_URL+'/rest/v1/rpc/purge_report_retention_terminal_receipts');assert.equal(new Headers(init?.headers).get('authorization'),'Bearer fixture-service');assert.deepEqual(JSON.parse(String(init?.body)),{p_global_token:token,p_limit:3});assert.ok(init?.signal instanceof AbortSignal);return Response.json({purged:3});});
 const result=await port(token,3,new AbortController().signal);assert.deepEqual(result,{purged:3});assert.ok(Object.isFrozen(result));assert.equal(calls,1);
});
test('누락 자격·토큰·한도·취소 예산은 전송 전에 거절',async()=>{
 let calls=0;const fetcher=async()=>{calls++;return Response.json({purged:0});};
 for(const key of ['SUPABASE_SERVICE_ROLE_KEY','INTERNAL_WORKER_SECRET'])assert.throws(()=>createReportRetentionMaintenancePort(loadRuntimeConfig(k=>k===key?undefined:values[k]),fetcher));
 const port=createReportRetentionMaintenancePort(config,fetcher);
 for(const limit of [0,21,1.5,NaN])await assert.rejects(port(token,limit,new AbortController().signal),code('INVALID_REQUEST'));
 await assert.rejects(port('00000000-0000-0000-0000-000000000000',1,new AbortController().signal),code('INVALID_REQUEST'));
 const abort=new AbortController();abort.abort();await assert.rejects(port(token,1,abort.signal),code('STATE_CONFLICT'));assert.equal(calls,0);
});
test('명확한401/403 거절은 UNKNOWN으로 바꾸지 않으며 재전송 없음',async()=>{
 for(const status of [401,403]){let calls=0;const port=createReportRetentionMaintenancePort(config,async()=>{calls++;return Response.json({code:'42501'},{status});});await assert.rejects(port(token,20,new AbortController().signal),e=>!(e instanceof ReportRetentionMaintenanceUnknown));assert.equal(calls,1);}
});
test('전송 후 유실·5xx·잘못된 DTO는 UNKNOWN, 자동 반복 없음',async()=>{
 for(const body of [null,{},[],{purged:-1},{purged:21},{purged:0.5},{purged:'1'},{purged:1,extra:true}]){let calls=0;const port=createReportRetentionMaintenancePort(config,async()=>{calls++;return Response.json(body);});await assert.rejects(port(token,20,new AbortController().signal),ReportRetentionMaintenanceUnknown);assert.equal(calls,1);}
 for(const fail of ['network','503']){let calls=0;const port=createReportRetentionMaintenancePort(config,async()=>{calls++;if(fail==='network')throw Error('private provider detail');return Response.json({code:'internal'},{status:503});});await assert.rejects(port(token,20,new AbortController().signal),e=>e instanceof ReportRetentionMaintenanceUnknown&&e.terminal&&!e.message.includes('private'));assert.equal(calls,1);}
});
test('전송 후 예산 취소·abort 무시 fetch도 UNKNOWN으로 즉시 종료',async()=>{
 const abort=new AbortController();let calls=0;const port=createReportRetentionMaintenancePort(config,async()=>{calls++;abort.abort();return new Promise<Response>(()=>{});});await assert.rejects(port(token,20,abort.signal),ReportRetentionMaintenanceUnknown);assert.equal(calls,1);
});
