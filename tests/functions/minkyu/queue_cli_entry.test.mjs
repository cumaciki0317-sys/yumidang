import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runQueueRunnerCli } from '../../../backend/supabase/functions/scheduled-jobs/queue-runner.mjs';
import { createConfiguredQueueRuntime } from '../../../backend/supabase/functions/_shared/jobs/runtime.ts';
import { HttpError } from '../../../backend/supabase/functions/_shared/http/errors.ts';

const env = { SUPABASE_URL:'https://example.supabase.co', SUPABASE_ANON_KEY:'anon',
  SUPABASE_SERVICE_ROLE_KEY:'service', INTERNAL_WORKER_SECRET:'x'.repeat(32),
  UPSTREAM_TIMEOUT_MS:'1000', MAX_REQUEST_BYTES:'65536', ALLOWED_ORIGINS:'[]' };
const config = { contractId:'reviewed-server-contract', workerSecret:env.INTERNAL_WORKER_SECRET,
  functionUrl:env.SUPABASE_URL+'/functions/v1/review-summary-worker' };
function fixture(extra = {}) {
  const signals = new EventEmitter(), events = [], reports = [], exits = [];
  const runtime = { supportedKinds:[], async preflight(){ events.push('preflight'); } };
  const dependencies = { signals, readConfig:()=>config,
    createRuntime:async()=>runtime, loadClient:async()=>{events.push('load');return class Client {};},
    start:()=>{events.push('start');return{ready:Promise.resolve(),async stop(){events.push('stop');}};},
    report:code=>reports.push(code), setExitCode:code=>exits.push(code), ...extra };
  return { signals, events, reports, exits, dependencies, runtime };
}

test('stock entry ignores env approval toggles and uses actual maintenance-only runtime', async () => {
  const f=fixture();let captured, rpc=0;
  f.dependencies.createRuntime=async(...args)=>{
    captured=args[2];const db={async rpc(name,input){rpc++;assert.equal(name,'get_queue_invocation');assert.equal(input.p_request_id,'00000000-0000-0000-0000-000000000000');throw new HttpError('RESOURCE_NOT_FOUND');}};
    const actual=createConfiguredQueueRuntime(args[0],args[1],{db});assert.deepEqual(actual.supportedKinds,[]);return actual;
  };
  const running=await runQueueRunnerCli({env:{...env,WORKER_QUEUE_APPROVED:'true',WORKER_QUEUE_APPROVALS:'{"review":{"approved":true}}'},dependencies:f.dependencies});
  assert.ok(running);assert.equal(captured,undefined);assert.equal(rpc,1);assert.deepEqual(f.events,['load','start']);await running.stop();assert.deepEqual(f.reports,[]);
});

test('fixed server approval with another contract fails before RPC, client load or start', async () => {
  const f=fixture();let rpc=0;
  f.dependencies.createRuntime=(values,cfg,options)=>createConfiguredQueueRuntime(values,cfg,{...options,db:{async rpc(){rpc++;assert.fail();}}});
  const result=await runQueueRunnerCli({env,trustedAssembly:{review:{approved:true,decisionId:'another-contract',maxJobsPerRun:10,timeBudgetMs:60000}},dependencies:f.dependencies});
  assert.equal(result,null);assert.equal(rpc,0);assert.deepEqual(f.events,[]);assert.deepEqual(f.reports,['WORKER_QUEUE_NOT_CONFIGURED']);assert.deepEqual(f.exits,[1]);
});

test('preflight failure starts no client or listener and exposes only a fixed code', async () => {
  const f=fixture();f.runtime.preflight=async()=>{throw Error('private-details-must-not-be-output');};
  assert.equal(await runQueueRunnerCli({env,dependencies:f.dependencies}),null);
  assert.deepEqual(f.events,[]);assert.equal(f.signals.listenerCount('SIGTERM'),0);assert.deepEqual(f.reports,['WORKER_QUEUE_NOT_CONFIGURED']);
});

test('JSON approval input, arbitrary module path and missing approved lane fail closed', async () => {
  for(const trustedAssembly of ['{"review":{"approved":true}}',{modulePath:'/tmp/untrusted.mjs'},
    {review:{approved:true,decisionId:config.contractId,maxJobsPerRun:10,timeBudgetMs:60000}}]){
    const f=fixture();assert.equal(await runQueueRunnerCli({env,trustedAssembly,dependencies:f.dependencies}),null);
    assert.deepEqual(f.events,[]);assert.deepEqual(f.reports,['WORKER_QUEUE_NOT_CONFIGURED']);
  }
});

test('server literal assembly and transport pass through the shared entry before startup', async () => {
  const trustedAssembly=Object.freeze({review:Object.freeze({approved:true,decisionId:config.contractId,maxJobsPerRun:10,timeBudgetMs:60000})});
  const fetchImpl=async()=>assert.fail('no network needed'), f=fixture({fetchImpl});
  f.runtime.supportedKinds=['review_summary'];f.dependencies.createRuntime=async(values,cfg,options)=>{
    assert.equal(values,env);assert.equal(cfg,config);assert.equal(options.review,trustedAssembly.review);assert.equal(options.fetch,fetchImpl);return f.runtime;
  };
  const start=f.dependencies.start;f.dependencies.start=options=>{assert.equal(options.sharedRuntime,f.runtime);assert.equal(options.fetchImpl,fetchImpl);return start(options);};
  const running=await runQueueRunnerCli({env,trustedAssembly,dependencies:f.dependencies});assert.ok(running);assert.deepEqual(f.events,['preflight','load','start']);await running.stop();
});

test('both signals and explicit stop share one shutdown and remove signal handlers', async () => {
  const f=fixture();let finish,stopCalls=0;
  f.dependencies.start=()=>({ready:Promise.resolve(),stop:()=>{stopCalls++;return new Promise(resolve=>{finish=resolve;});}});
  const running=await runQueueRunnerCli({env,dependencies:f.dependencies});assert.ok(running);
  f.signals.emit('SIGINT');f.signals.emit('SIGTERM');const closing=running.stop();await Promise.resolve();assert.equal(stopCalls,1);
  finish();await closing;assert.equal(f.signals.listenerCount('SIGINT'),0);assert.equal(f.signals.listenerCount('SIGTERM'),0);assert.deepEqual(f.reports,[]);
});

test('ready rejection drains the actual started runner and removes listeners', async () => {
  const f=fixture();let stops=0;f.dependencies.start=()=>({ready:Promise.reject(Error('private-startup-details')),async stop(){stops++;}});
  assert.equal(await runQueueRunnerCli({env,dependencies:f.dependencies}),null);assert.equal(stops,1);
  assert.equal(f.signals.listenerCount('SIGTERM'),0);f.signals.emit('SIGTERM');assert.equal(stops,1);assert.deepEqual(f.reports,['WORKER_QUEUE_NOT_CONFIGURED']);
});
