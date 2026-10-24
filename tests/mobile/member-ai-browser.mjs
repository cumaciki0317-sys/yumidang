/** Actual Expo screens with synthetic sessions/HTTP. Test-only routes exist in a temporary copy only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const source=path.resolve(process.env.MEMBER_AI_SOURCE_ROOT||path.join(import.meta.dirname,'../..'));
const actual=path.resolve(import.meta.dirname,'../../apps/mobile');
const require=createRequire(path.join(actual,'package.json'));
const {chromium}=require('playwright');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'yumidang-member-ai-browser-'));
const app=path.join(temp,'apps/mobile'), output=path.join(temp,'web');
await fs.mkdir(app,{recursive:true});
await fs.cp(path.join(source,'apps/mobile/src'),path.join(app,'src'),{recursive:true});
for(const name of ['package.json','app.json','tsconfig.json','metro.config.js']) await fs.copyFile(path.join(source,'apps/mobile',name),path.join(app,name));
await fs.symlink(path.join(actual,'node_modules'),path.join(app,'node_modules'),'dir');
await fs.symlink(path.join(actual,'assets'),path.join(app,'assets'),'dir');
await fs.symlink(path.resolve(actual,'../../backend'),path.join(temp,'backend'),'dir');
const sourceHashes={};
for(const name of ['screens/RemoteMemberScreens.tsx','screens/RemoteScreens.tsx','screens/AuthAiScreens.tsx','state.tsx','storage.ts','member-service.ts','remote.tsx','ai-consent-state.ts','member-device-cleanup.ts','presentation/member-ai-consents.tsx']) sourceHashes[name]=createHash('sha256').update(await fs.readFile(path.join(app,'src',name))).digest('hex');
// The symlinked Expo Router entry has a shared real path: isolate its transform cache per source copy.
await fs.appendFile(path.join(app,'metro.config.js'),`\nmodule.exports.cacheVersion = ${JSON.stringify(temp)};\n`);
await fs.writeFile(path.join(app,'src/app/member-ai-test.tsx'),`import React from 'react';
import {View,Text,Pressable} from 'react-native';
import {useLocalSearchParams} from 'expo-router';
import {installMemberSessionPort,installPhotoStoragePort,installMemberSessionDetails,useServiceSession} from '../remote';
import {SignupScreen} from '../screens/AuthAiScreens';
import {RemoteAccountScreen} from '../screens/RemoteMemberScreens';
const uid='11111111-1111-4111-8111-111111111111';
const signup=(status:string)=>({status,avatarPath:uid+'/22222222-2222-4222-8222-222222222222.jpg',interests:[],conversationStyles:[],mbti:null});
export default function Test(){ const {view}=useLocalSearchParams();const session=useServiceSession();
const install=()=>{let retired=false;const port={login:async()=>null,restore:async()=>new Promise(()=>{}),logout:async()=>{},signupState:async()=>signup('completion_required'),complete:async()=>signup('ready'),retire:async(withdrawalId:string)=>{const status=retired?'completed':'processing';retired=true;return{withdrawalId,status,memberAccessRevoked:true};}};
installMemberSessionPort(port);installPhotoStoragePort({});installMemberSessionDetails({userId:uid,accessToken:'synthetic-member',status:view==='signup'?'completion_required':'ready',returnTo:'/'});};
return <View style={{flex:1}}><Text>합성 회원·HTTP 화면 검증</Text><Pressable accessibilityRole="button" onPress={install}><Text>합성 회원 설치</Text></Pressable>{view==='signup'?(session.authenticated?<SignupScreen/>:<Text>설치 대기</Text>):<RemoteAccountScreen/>}</View>;
}`);
const env={...process.env,EXPO_OFFLINE:'1',CI:'1',EXPO_NO_TELEMETRY:'1',EXPO_PUBLIC_DATA_MODE:'service',EXPO_PUBLIC_SERVICE_API_URL:'https://api.synthetic.test/service-api',EXPO_PUBLIC_AI_CHAT_URL:'https://api.synthetic.test/ai-chat'};
const buildLog=path.join(temp,'export.log');
await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[path.join(actual,'node_modules/expo/bin/cli'),'export','--platform','web','--output-dir',output],{cwd:app,env});let log='';p.stdout.on('data',c=>{log+=c;});p.stderr.on('data',c=>{log+=c;});p.on('error',reject);p.on('close',async code=>{await fs.writeFile(buildLog,log);if(code===0)resolve();else reject(new Error('Expo export failed: '+log.slice(-3500)));});});
const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.ttf':'font/ttf','.woff2':'font/woff2','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);let file=path.resolve(output,'.'+pathname);if(!file.startsWith(output+path.sep)&&file!==output){res.writeHead(403);return res.end();}try{if(!(await fs.stat(file)).isFile())file=path.join(output,'index.html');}catch{file=path.join(output,'index.html');}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(await fs.readFile(file));}catch{res.writeHead(500);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/Users/b/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'});
const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);
const checks=[],errors=[],external=[],calls=[];let failSource=true;
let consents={exploration:false,summary_view:false,summary_generate:false,summary_source:false};
const record=(name,pass)=>{checks.push({name,pass:!!pass});console.log(pass?'PASS':'FAIL',name);};
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',async route=>{
 const req=route.request(),u=new URL(req.url());if(u.origin===base)return route.continue();
 if(u.origin!=='https://api.synthetic.test'){external.push(u.origin);return route.abort();}
 const pathname=u.pathname.replace('/service-api','');const input=req.postData()?JSON.parse(req.postData()):null;calls.push({path:pathname,input});
 let data,status=200;
 if(pathname==='/me/ai-consents')data={...consents};
 else if(pathname==='/me/ai-consents/set'){if(failSource&&input.kind==='summary_source')status=503;else consents[input.kind]=input.allowed;data={...consents};}
 else if(pathname==='/me/safety')data={permanent:false,restrictedUntil:null,hasWarning:false,sanctions:[]};
 else if(['/me/blocks','/me/reports','/me/hidden-targets'].includes(pathname))data={items:[],nextCursor:null};
 else if(pathname==='/me')data={userId:'11111111-1111-4111-8111-111111111111',realName:'합성 회원',avatarUrl:null,bio:null,sweetness:15};
 else{external.push('UNEXPECTED_API:'+pathname);return route.abort();}
 await route.fulfill({status,contentType:'application/json',body:JSON.stringify(status===200?{data}:{error:{code:'EXTERNAL_UNAVAILABLE'}})});
});
const click=name=>page.getByRole('button',{name,exact:true}).last().click();
const body=()=>page.locator('body').innerText();
const readyButton=async name=>page.waitForFunction(name=>[...document.querySelectorAll('[role=button]')].some(el=>{if(el.textContent.trim()!==name||el.getAttribute('aria-disabled')==='true')return false;let opacity=1;for(let node=el;node;node=node.parentElement)opacity*=Number(getComputedStyle(node).opacity);return opacity>.99;}),name);
const install=async view=>{await page.goto(base+'/member-ai-test?view='+view);await click('합성 회원 설치');};
const report=process.env.MEMBER_AI_BROWSER_RESULT||'/private/tmp/yumidang-member-ai-browser-result.json';
try{
 await install('signup');await page.getByText('후기 AI 선택 동의',{exact:true}).waitFor();
 record('가입 기본 3동의 미선택',!Object.values(consents).some(Boolean));
 await click('후기 AI 전체 동의');await click('가입 완료');
 await page.getByText('가입은 완료됐어요. 일부 AI 선택 동의의 저장을 확인하지 못했어요. 다시 시도하거나 나중에 계정 관리에서 설정할 수 있어요.',{exact:true}).waitFor();
 record('가입 성공과 동의 일부 실패 안내 분리',(await body()).includes('가입 프로필을 완성했어요')&&consents.summary_view&&consents.summary_generate&&!consents.summary_source&&!consents.exploration);
 await readyButton('나중에 설정하고 계속');await page.screenshot({path:path.join(temp,'signup-consent-partial.png'),animations:'disabled'});
 const before=calls.filter(c=>c.path==='/me/ai-consents/set').length;failSource=false;await click('동의 저장 다시 시도');await page.getByRole('button',{name:'확인하고 계속',exact:true}).waitFor();
 record('실패한 동의만 수동 저장',consents.summary_source&&calls.filter(c=>c.path==='/me/ai-consents/set').length===before+1);
 await readyButton('확인하고 계속');await page.screenshot({path:path.join(temp,'signup-consent-confirmed.png'),animations:'disabled'});
 await install('account');await click('AI 동의');await page.getByRole('button',{name:'후기 요약 열람 동의 철회',exact:true}).waitFor();
 await click('후기 요약 열람 동의 철회');await click('철회 확인');await page.getByRole('button',{name:'후기 요약 열람 동의하기',exact:true}).waitFor();
 record('AI 열람 철회는 다른 두 동의를 유지',!consents.summary_view&&consents.summary_generate&&consents.summary_source);
 await readyButton('후기 요약 열람 동의하기');record('설정 화면은 재조회한 실제 동의 상태를 표시',(await body()).includes('동의하지 않음')&&(await body()).includes('동의함'));await page.screenshot({path:path.join(temp,'account-independent-consents.png'),animations:'disabled'});
 await install('account');await click('회원 탈퇴');await click('회원 탈퇴');await click('탈퇴 요청 확인');
 await page.getByText('회원 탈퇴를 처리하고 있어요',{exact:true}).last().waitFor();record('일반 회원 권한 밖에서 처리 중 영수증 유지',(await body()).includes('처리하고 있어요'));
 await page.screenshot({path:path.join(temp,'retirement-processing.png')});
 await click('탈퇴 상태 다시 확인');await page.getByText('회원 탈퇴 처리가 완료됐어요',{exact:true}).last().waitFor();record('같은 요청 수동 확인 후 완료 구분',(await body()).includes('완료'));
 await page.screenshot({path:path.join(temp,'retirement-completed.png')});
 record('회원 UUID·JWT 원문 UI 노출 없음',!(await body()).includes('11111111-1111-4111-8111-111111111111')&&!(await body()).includes('synthetic-member'));
 record('모바일 가로 넘침 없음',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 record('런타임 오류·실제 외부 요청 없음',errors.length===0&&external.length===0);
}catch(error){errors.push(String(error));console.error((await body()).slice(-3000));await page.screenshot({path:path.join(temp,'failure.png')});}
finally{await browser.close();await new Promise(resolve=>server.close(resolve));await fs.writeFile(report,JSON.stringify({status:checks.every(c=>c.pass)&&!errors.length&&!external.length?'PASS':'FAIL',source,sourceHashes,temp,buildLog,checks,errors,external,scope:'Actual Expo web rendering with synthetic member ports/HTTP. No provider, real server, real member or native-device verification.'},null,2));console.log('RESULT',report);}
assert.equal(JSON.parse(await fs.readFile(report,'utf8')).status,'PASS');
