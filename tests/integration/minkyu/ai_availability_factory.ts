/** 민규: 원 제품 createRuntimeHandler의 단일 GET 전용 entry. DB fixture 권한 없음. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
const fail=(ok:unknown):asserts ok=>{if(!ok)throw new Error('AVAIL_FACTORY_CONTRACT');};
const digest=(raw:Buffer)=>createHash('sha256').update(raw).digest('hex');
function sealed(path:string,limit:number,secret=false):Buffer{
 fail(resolve(path)===path&&realpathSync(path)===path);
 let parent=dirname(path);while(parent!==dirname(parent)){fail(!lstatSync(parent).isSymbolicLink());parent=dirname(parent);}
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=fstatSync(fd);fail(before.isFile()&&before.nlink===1&&before.uid===process.getuid?.()&&before.size<=limit&&(!secret||(before.mode&0o777)===0o600));
  const raw=readFileSync(fd),after=fstatSync(fd),leaf=lstatSync(path);
  fail(raw.length===before.size&&before.ino===after.ino&&before.size===after.size&&before.mtimeMs===after.mtimeMs&&before.ctimeMs===after.ctimeMs&&leaf.ino===after.ino&&leaf.dev===after.dev);return raw;
 }finally{closeSync(fd);}
}
export async function run(packetPath:string):Promise<unknown>{
 const raw=sealed(packetPath,1048576,true),p=JSON.parse(raw.toString());
 fail(Object.keys(p).sort().join(',')==='anon,capsule,origin,pins,scopeId,state,token');
 fail(typeof p.scopeId==='string'&&/^[a-f0-9]{32}$/.test(p.scopeId)&&['processing_disabled','consent_required','concurrent','daily_limit','estimated_eligible'].includes(p.state));
 const origin=new URL(p.origin);fail(origin.protocol==='http:'&&origin.hostname==='127.0.0.1'&&origin.origin===p.origin&&Number(origin.port)>=1024);
 fail(typeof p.token==='string'&&p.token.split('.').length===3&&typeof p.anon==='string'&&p.anon.length>10);
 fail(typeof p.capsule==='string'&&resolve(p.capsule)===p.capsule&&p.capsule.startsWith('/private/tmp/')&&realpathSync(p.capsule)===p.capsule);
 fail(p.pins&&typeof p.pins==='object'&&!Array.isArray(p.pins));
 const entry='backend/supabase/functions/service-api/index.ts';fail(entry in p.pins);
 for(const [relative,hash]of Object.entries(p.pins)){
  fail(/^backend\/supabase\/functions\/[A-Za-z0-9_./-]+\.ts$/.test(relative)&&!relative.split('/').includes('..')&&typeof hash==='string'&&/^[a-f0-9]{64}$/.test(hash));
  fail(digest(sealed(resolve(p.capsule,relative),4194304))===hash);
 }
 // closure 전체성과 원 HEAD blob/Node SHA/권한은 Python root adapter의 실행 전 조건이다.
 const observations:{origin:string,path:string,method:string}[]=[];let traceOverflow=false;
 const trace=channel('undici:request:create');const subscriber=(message:any)=>{const r=message.request;if(observations.length>=16){traceOverflow=true;return;}observations.push({origin:String(r.origin),path:String(r.path),method:String(r.method)});};
 trace.subscribe(subscriber);
 try{
 const {createRuntimeHandler}=await import(pathToFileURL(resolve(p.capsule,entry)).href);
 const env:Record<string,string>={SUPABASE_URL:p.origin,SUPABASE_ANON_KEY:p.anon,UPSTREAM_TIMEOUT_MS:'5000',MAX_REQUEST_BYTES:'65536',ALLOWED_ORIGINS:'[]'};
 const handler=createRuntimeHandler((key:string)=>env[key]);
 const response=await handler(new Request(p.origin+'/functions/v1/service-api/me/ai-availability',{method:'GET',headers:{authorization:'Bearer '+p.token}}));
 const reader=response.body?.getReader();let size=0;const chunks:Uint8Array[]=[];
 try{if(reader)for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;fail(size<=65536);chunks.push(item.value);}}
 finally{await reader?.cancel();reader?.releaseLock();}
 const body=Buffer.concat(chunks);
 fail(!traceOverflow&&observations.length===2&&observations[0].origin===p.origin&&observations[0].path==='/auth/v1/user'&&observations[0].method==='GET'&&observations[1].origin===p.origin&&observations[1].path==='/rest/v1/rpc/get_my_ai_availability'&&observations[1].method==='POST');
 return {scope:'AVAILABILITY_SINGLE_FACTORY_GET',scopeId:p.scopeId,state:p.state,packetSha256:digest(raw),method:'GET',path:'/functions/v1/service-api/me/ai-availability',httpStatus:response.status,bodyBase64:body.toString('base64'),bodySha256:digest(body),calls:1,automaticReplay:false,modelDispatch:0,observations,networkObserver:'NODE_UNDICI_REQUEST_CREATE',databasePreservation:'CALLER_REQUIRED'};
 }finally{trace.unsubscribe(subscriber);}
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(new URL(import.meta.url).pathname)){
 if(process.argv.length!==3){console.log(JSON.stringify({status:'NOT_RUN'}));}
 else run(process.argv[2]).then(value=>console.log(JSON.stringify(value))).catch(()=>{console.log(JSON.stringify({status:'FAIL_CLOSED',secretValuesPrinted:false}));process.exitCode=1;});
}
