import { test } from "node:test";
import assert from "node:assert/strict";
import { rootCertificates } from "node:tls";
import { inspectRuntimeConfiguration } from "../../../tools/local/check_production_runtime.mjs";
const values={SUPABASE_URL:"https://project.test",SUPABASE_ANON_KEY:"synthetic-anon",SUPABASE_SERVICE_ROLE_KEY:"synthetic-service",
  INTERNAL_WORKER_SECRET:"synthetic_internal_secret_long_enough_123",ALLOWED_ORIGINS:'["https://app.test"]',
  MAX_REQUEST_BYTES:"65536",UPSTREAM_TIMEOUT_MS:"1000",
  COMPLETION_DATABASE_URL:"postgresql://completion_login:synthetic-password@db.test/postgres",COMPLETION_DB_LOGIN_ROLE:"completion_login",
  COMPLETION_RECONNECT_MS:"5000",COMPLETION_QUERY_TIMEOUT_MS:"10000",
  WORKER_QUEUE_DATABASE_URL:"postgresql://queue_login:synthetic-password@db.test/postgres",WORKER_QUEUE_DB_LOGIN_ROLE:"queue_login",
  WORKER_QUEUE_FUNCTION_URL:"https://project.test/functions/v1/review-summary-worker",WORKER_QUEUE_DB_CA_PEM:rootCertificates[0],
  WORKER_QUEUE_DB_CONTRACT_ID:"test-contract-v1",WORKER_QUEUE_RECONNECT_MS:"5000",WORKER_QUEUE_QUERY_TIMEOUT_MS:"10000",WORKER_QUEUE_HTTP_TIMEOUT_MS:"75000",
  POTENS_ACCOUNT_ORDER:"yumi,jonghyun",POTENS_API_KEY_YUMI:"synthetic-key1",POTENS_API_KEY_JONGHYUN:"synthetic-key2",
  POTENS_ACCOUNT_TOKEN_BUDGET:"3200000",POTENS_RESET_TIMEZONE:"Asia/Seoul",POTENS_MODEL:"claude-5-sonnet"};

test("actual runtime loaders syntax PASS never implies network, privileges, product or activation",()=>{
  const r=inspectRuntimeConfiguration(values);assert.equal(r.status,"CONFIG_SYNTAX_ONLY");
  for(const key of ["connectionCheck","databaseEffectivePrivileges","tlsHandshake","productCli","supplierApproval"])assert.equal(r[key],"NOT_RUN");
  assert.equal(r.activationAllowed,false);assert.equal(r.operatingChanged,false);
  assert.doesNotMatch(JSON.stringify(r),/synthetic-|db\.test|project\.test|BEGIN CERTIFICATE/);
});
test("zero variables, SSL override, HTTP destination, privileged login and malformed CA stay blocked",()=>{
  assert.equal(inspectRuntimeConfiguration({}).status,"BLOCKED");
  for(const [key,value,check] of [
    ["COMPLETION_DATABASE_URL",values.COMPLETION_DATABASE_URL+"?sslmode=disable","completion"],
    ["COMPLETION_DATABASE_URL","postgresql://postgres:password@db.test/postgres","completion"],
    ["COMPLETION_DATABASE_URL","postgresql://completion_login:password@127.0.0.1/postgres","completion"],
    ["WORKER_QUEUE_DATABASE_URL",values.WORKER_QUEUE_DATABASE_URL+"?host=evil.test","queue"],
    ["WORKER_QUEUE_FUNCTION_URL","http://project.test/functions/v1/review-summary-worker","queue"],
    ["WORKER_QUEUE_FUNCTION_URL","https://project.test/functions/v1/service-api","queue"],
    ["WORKER_QUEUE_DB_CA_PEM","invalid-pem","queue"],
    ["INTERNAL_WORKER_SECRET",values.SUPABASE_SERVICE_ROLE_KEY,"api"],
    ["ALLOWED_ORIGINS",'["http://app.test"]',"api"],
    ["MAX_REQUEST_BYTES","1048576","api"],
    ["POTENS_ACCOUNT_TOKEN_BUDGET","3510000","aiAccountPool"],
    ["POTENS_RESET_TIMEZONE","UTC","aiAccountPool"],
  ])assert.equal(inspectRuntimeConfiguration({...values,[key]:value}).checks[check],"BLOCKED",key);
});
test("completion and queue cannot use the same declared LOGIN",()=>{
  const r=inspectRuntimeConfiguration({...values,WORKER_QUEUE_DATABASE_URL:values.COMPLETION_DATABASE_URL,WORKER_QUEUE_DB_LOGIN_ROLE:"completion_login"});
  assert.equal(r.checks.roleSeparation,"BLOCKED");assert.equal(r.activationAllowed,false);
});
test("malformed input is rejected without raw values",()=>{
  assert.throws(()=>inspectRuntimeConfiguration({secret:{password:"sensitive"}}),/INVALID_INPUT/);
});
