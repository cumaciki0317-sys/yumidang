/** 실제 민규 소유 로컬 DB/Storage에 기존 종현 소비자를 연결한다. 제품 runner 활성화가 아니다. */
import {loadRuntimeConfig} from '../../../backend/supabase/functions/_shared/config/env.ts';
import {createInternalClient} from '../../../backend/supabase/functions/_shared/db/internal-client.ts';
import {createWorkerRunScope} from '../../../backend/supabase/functions/_shared/jobs/worker-run.ts';
import {createRpcJobRepository} from '../../../backend/supabase/functions/_shared/db/repositories/jobs.ts';
import {createRpcSafetyConsumerPorts,createSafetyConsumerRegistry} from '../../../backend/supabase/functions/_shared/jobs/safety-consumers.ts';
const ROOT='/private/tmp/yumidang-runner-recovery99';
const s=JSON.parse(await Deno.readTextFile('/private/tmp/yumidang-release88-http-isolated/status-private.json'));
if(s.API_URL!=='http://127.0.0.1:59621')throw Error('OWNED_LOCAL_ONLY');
const input=JSON.parse(await Deno.readTextFile(ROOT+'/consumer-input.json'));
const values:Record<string,string>={SUPABASE_URL:s.API_URL,SUPABASE_ANON_KEY:s.ANON_KEY,SUPABASE_SERVICE_ROLE_KEY:s.SERVICE_ROLE_KEY,INTERNAL_WORKER_SECRET:'synthetic-local-worker-not-production',ALLOWED_ORIGINS:'[]',UPSTREAM_TIMEOUT_MS:'15000',MAX_REQUEST_BYTES:'65536'};
let deletes=0,external=0,lost=false;
const mode=Deno.args[0]??'success';
const safeFetch:typeof fetch=async(url,init)=>{
 const u=new URL(url instanceof Request?url.url:String(url));if(u.origin!==s.API_URL){external++;throw Error('EXTERNAL_BLOCKED');}
 const isDelete=init?.method==='DELETE'&&u.pathname==='/storage/v1/object/report-evidence';if(isDelete)deletes++;
 const response=await fetch(url,init);
 if(mode==='drop-delete'&&isDelete&&!lost){lost=true;await response.arrayBuffer();throw Error('SYNTHETIC_DELETE_RESPONSE_LOST');}
 if(mode==='drop-ack'&&u.pathname.endsWith('/record_report_retention_delete_ack')&&!lost){lost=true;await response.arrayBuffer();throw Error('SYNTHETIC_ACK_RESPONSE_LOST');}
 return response;
};
const config=loadRuntimeConfig(k=>values[k]),db=createInternalClient(config,safeFetch),scope=createWorkerRunScope(db),lease=await scope.open();
if(!lease)throw Error('TEST_WORKER_BUSY');
const file=await Deno.open(ROOT+'/consumer-journal.jsonl',{create:true,append:true,write:true,mode:0o600});
const append=async(v:unknown)=>{await file.write(new TextEncoder().encode(JSON.stringify(v)+'\n'));await file.sync();};
const journal={prepare:async(v:unknown)=>append({state:'prepared',intent:v}),confirmed:async(requestId:string)=>append({state:'confirmed',requestId}),unknown:async(requestId:string)=>append({state:'unknown',requestId})};
const controller=new AbortController();let operations=0;
const wired=createRpcSafetyConsumerPorts(config,{readiness:{scopedClaim:true,sharedBudgetContract:true,durableJournalContract:true,cancellationGuardAndAcl:true,reportGuardAndAcl:true,reportTerminalScheduleContract:true,storageProviderApproved:true},journal,budget:{globalToken:lease.token,signal:controller.signal,elapsed:()=>performance.now(),reserve:async()=>++operations<=20}},safeFetch);
// The 20 here is a test safety cap on operations, NOT the product shared job budget.
const registry=createSafetyConsumerRegistry(wired.consumers);
const repo=createRpcJobRepository(db,{workerRunToken:lease.token,supportedClaim:true,claimJournal:journal,settlementJournal:journal,signal:controller.signal});
try{
 const kind=input.kind as 'cancellation_safety'|'report_retention';
 const enqueue=await(kind==='report_retention'?wired.dueEnqueue.enqueueReportRetention(1,lease.token,controller.signal):wired.dueEnqueue.enqueueCancellation(1,lease.token,controller.signal));
 const job=await repo.claim({workerId:crypto.randomUUID(),kinds:[kind],leaseDurationMs:120000});if(!job)throw Error('LOCAL_JOB_MISSING');
 if(kind==='report_retention'&&job.reference.kind==='report_retention'&&job.reference.reportId!==input.reportId)throw Error('FOREIGN_FIXTURE_JOB');
 let result:unknown,status='completed';
 try{result=await registry[kind]!(job);}catch(e){
  if(mode==='success'||!(e instanceof Error)||!((e as Error&{terminal?:boolean}).terminal))throw e;
  status='unknown';result={terminal:true};
 }
 if(mode==='success'&&kind==='report_retention'&&(result as {status?:string}).status!=='completed_by_handler')throw Error('METADATA_MUST_COMPLETE_PARENT');
 if(mode==='success'&&kind==='cancellation_safety'){
  if((result as {status?:string}).status!=='succeeded')throw Error('CANCELLATION_NOT_APPLIED');
  await repo.settle({jobId:job.jobId,leaseToken:job.leaseToken,status:'succeeded'});
 }
 const receipt={kind,mode,status,deletes,external,operations,result};
 await Deno.writeTextFile(ROOT+'/consumer-'+mode+'-'+kind+'.json',JSON.stringify(receipt));console.log(JSON.stringify(receipt));
}catch(e){console.error('LOCAL_CONSUMER_FAILED',e instanceof Error?e.name:'unknown');throw e;}finally{file.close();await scope.close(lease);}
