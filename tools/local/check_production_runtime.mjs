/** 민규: 기존 runtime loader만 호출하는 offline 설정 검사. 연결/서버 시작/활성화 없음. */
import { pathToFileURL } from "node:url";
import { loadRuntimeConfig, requireInternalConfig, loadPotensAccountPoolConfig } from "../../backend/supabase/functions/_shared/config/env.ts";
import { readCompletionConfig } from "../../backend/supabase/functions/scheduled-jobs/completion-runner.mjs";
import { readQueueRunnerConfig } from "../../backend/supabase/functions/scheduled-jobs/queue-runner.mjs";

const forbiddenRoles = new Set(["postgres","supabase_admin","service_role","anon","authenticated","authenticator",
  "supabase_storage_admin","supabase_auth_admin","yumidang_completion_runner","yumidang_worker_queue"]);
function dedicatedLogin(databaseUrl, declared) {
  const url=new URL(databaseUrl), login=decodeURIComponent(url.username);
  if (!/^[A-Za-z_][A-Za-z0-9_$]{0,62}$/.test(declared??"") || login!==declared || forbiddenRoles.has(login) ||
    !url.password || !url.hostname || url.search || url.hash || url.pathname==="/" ||
    ["localhost","127.0.0.1","[::1]"].includes(url.hostname)) throw new Error("INVALID_ROLE_CONFIG");
  return login;
}
export function inspectRuntimeConfiguration(env) {
  if (!env || typeof env!=="object" || Array.isArray(env) || Object.values(env).some(v=>typeof v!=="string")) throw new Error("INVALID_INPUT");
  const checks={};let completion,queue;
  const check=(name,fn)=>{try{fn();checks[name]="SYNTAX_PASS_NOT_CONNECTED";}catch{checks[name]="BLOCKED";}};
  check("api",()=>{
    const config=loadRuntimeConfig(key=>env[key]);requireInternalConfig(config);
    if(!config.supabaseUrl.startsWith("https://") || config.maxRequestBytes!==65536 ||
      config.allowedOrigins.some(origin=>!origin.startsWith("https://")))throw new Error();
  });
  check("completion",()=>{
    const config=readCompletionConfig(env);
    completion=dedicatedLogin(config.databaseUrl,env.COMPLETION_DB_LOGIN_ROLE);
    if(config.ssl?.rejectUnauthorized!==true)throw new Error();
  });
  check("queue",()=>{
    const config=readQueueRunnerConfig(env);
    queue=dedicatedLogin(config.databaseUrl,env.WORKER_QUEUE_DB_LOGIN_ROLE);
  });
  check("roleSeparation",()=>{
    if(checks.completion!=="SYNTAX_PASS_NOT_CONNECTED" || checks.queue!=="SYNTAX_PASS_NOT_CONNECTED" || completion===queue)throw new Error();
  });
  check("aiAccountPool",()=>{if(!loadPotensAccountPoolConfig(key=>env[key]))throw new Error();});
  return {status:Object.values(checks).every(v=>v==="SYNTAX_PASS_NOT_CONNECTED")?"CONFIG_SYNTAX_ONLY":"BLOCKED",
    checks,offline:true,connectionCheck:"NOT_RUN",databaseEffectivePrivileges:"NOT_RUN",tlsHandshake:"NOT_RUN",
    productCli:"NOT_RUN",supplierApproval:"NOT_RUN",activationAllowed:false,operatingChanged:false};
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    let input="";
    for await (const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>1024*1024)throw new Error();}
    const result=inspectRuntimeConfiguration(JSON.parse(input));
    process.stdout.write(JSON.stringify(result)+"\n");
    process.exitCode=result.status==="BLOCKED"?2:0;
  }catch{
    process.stdout.write(JSON.stringify({status:"BLOCKED",error:"RUNTIME_CONFIGURATION_CHECK_FAILED",activationAllowed:false,operatingChanged:false})+"\n");
    process.exitCode=1;
  }
}
