/** Actual Expo screens with synthetic sessions/HTTP. Test-only routes exist in a temporary copy only. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const source=path.resolve(process.env.NIGHT_SOURCE_ROOT||path.join(import.meta.dirname,'../..'));
const actual=path.resolve(import.meta.dirname,'../../apps/mobile');
const require=createRequire(path.join(actual,'package.json'));
const {chromium}=require('playwright');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'yumidang-night-browser-'));
const app=path.join(temp,'apps/mobile'), output=path.join(temp,'web');
await fs.mkdir(app,{recursive:true});
await fs.cp(path.join(source,'apps/mobile/src'),path.join(app,'src'),{recursive:true});
for(const name of ['package.json','app.json','tsconfig.json','metro.config.js']) await fs.copyFile(path.join(source,'apps/mobile',name),path.join(app,name));
await fs.symlink(path.join(actual,'node_modules'),path.join(app,'node_modules'),'dir');
await fs.symlink(path.join(actual,'assets'),path.join(app,'assets'),'dir');
await fs.symlink(path.resolve(actual,'../../backend'),path.join(temp,'backend'),'dir');
const sourceHashes={};
for(const name of ['RemoteMemberScreens.tsx','RemoteScreens.tsx']) sourceHashes[name]=createHash('sha256').update(await fs.readFile(path.join(app,'src/screens',name))).digest('hex');
// The symlinked Expo Router entry has a shared real path: isolate its transform cache per source copy.
await fs.appendFile(path.join(app,'metro.config.js'),`\nmodule.exports.cacheVersion = ${JSON.stringify(temp)};\n`);
await fs.writeFile(path.join(app,'src/app/night-test.tsx'),`import React from 'react';
import {View,Text,Pressable} from 'react-native';
import {router,useLocalSearchParams} from 'expo-router';
import {installMemberSessionDetails,installServiceSession,useServiceSession} from '../remote';
import {RemoteChatScreen} from '../screens/RemoteMemberScreens';
import {RemoteAiScreen} from '../screens/RemoteScreens';
export default function Test(){ const {view}=useLocalSearchParams(); const s=useServiceSession();
const button=(label:string,fn:()=>void)=><Pressable accessibilityRole="button" onPress={fn}><Text>{label}</Text></Pressable>;
return <View style={{flex:1}}><Text>검증 소스 ${sourceHashes['RemoteScreens.tsx'].slice(0,12)} ${sourceHashes['RemoteMemberScreens.tsx'].slice(0,12)}</Text>{button('합성 세션 설치',()=>installMemberSessionDetails({userId:'11111111-1111-4111-8111-111111111111',accessToken:'synthetic-night-session',status:'ready',returnTo:'/'}))}
{button('합성 로그아웃',()=>installServiceSession(null))}{button('검증 화면 나가기',()=>router.push('/night-away'))}
{s.authenticated?(view==='chat'?<RemoteChatScreen conversationId="33333333-3333-4333-8333-333333333333"/>:<RemoteAiScreen/>):<Text>검증 세션 없음</Text>}</View>;
}`);
await fs.writeFile(path.join(app,'src/app/night-away.tsx'),`import React from 'react';import {View,Text,Pressable} from 'react-native';import {router} from 'expo-router';export default function Away(){return <View><Text>별도 검증 화면</Text><Pressable accessibilityRole="button" onPress={()=>router.back()}><Text>검증 화면 복귀</Text></Pressable></View>;}`);
const env={...process.env,EXPO_OFFLINE:'1',CI:'1',EXPO_NO_TELEMETRY:'1',EXPO_PUBLIC_DATA_MODE:'service',EXPO_PUBLIC_SERVICE_API_URL:'https://api.synthetic.test/service-api',EXPO_PUBLIC_AI_CHAT_URL:'https://api.synthetic.test/ai-chat'};
const buildLog=path.join(temp,'export.log');
await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[path.join(actual,'node_modules/expo/bin/cli'),'export','--platform','web','--output-dir',output],{cwd:app,env});let log='';p.stdout.on('data',c=>{log+=c;});p.stderr.on('data',c=>{log+=c;});p.on('error',reject);p.on('close',async code=>{await fs.writeFile(buildLog,log);if(code===0)resolve();else reject(new Error('Expo export failed: '+log.slice(-3500)));});});
const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.ttf':'font/ttf','.woff2':'font/woff2','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);let file=path.resolve(output,'.'+pathname);if(!file.startsWith(output+path.sep)&&file!==output){res.writeHead(403);return res.end();}try{if(!(await fs.stat(file)).isFile())file=path.join(output,'index.html');}catch{file=path.join(output,'index.html');}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(await fs.readFile(file));}catch{res.writeHead(500);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/Users/b/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'});
const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);
const checks=[],errors=[],external=[],calls=[];
let aiMode='success',releaseAi=null,releaseMessage=null,denyChat=false,postFailure=null,aiSequence=0;
const user='11111111-1111-4111-8111-111111111111',conversation='33333333-3333-4333-8333-333333333333',peer='22222222-2222-4222-8222-222222222222';
const now='2026-10-20T00:00:00Z', recent='최근 합성 메시지',old='과거 페이지 합성 비공개 메시지';
const result=(reason)=>({requestId:`44444444-4444-4444-8444-${String(++aiSequence).padStart(12,'0')}`,status:reason?'unavailable':'no_results',interpretedFilters:{target:'posts'},cards:[],explanations:[],notice:reason?'합성 중단 안내 '+reason:'확인된 합성 결과 없음',...(reason?{recovery:{reason,retryAllowed:reason==='output_privacy'||reason==='temporary'}}:{})});
const record=(name,ok)=>{checks.push({name,pass:!!ok});console.log(ok?'PASS':'FAIL',name);};
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.origin===base)return route.continue();if(u.origin!=='https://api.synthetic.test'){external.push(u.origin);return route.abort();}const pathname=u.pathname.replace('/service-api','');const input=req.postData()?JSON.parse(req.postData()):null;calls.push({path:pathname,method:req.method(),input});let data,status=200,code='EXTERNAL_UNAVAILABLE';
if(pathname==='/ai-chat'){if(aiMode==='delayed')await new Promise(resolve=>{releaseAi=resolve;});if(aiMode==='http401'){status=401;code='AUTH_REQUIRED';}else if(aiMode==='http503')status=503;else data=result(['input_privacy','output_privacy','daily_limit','concurrent','consent','temporary'].includes(aiMode)?aiMode:null);}
else if(pathname==='/me')data={userId:user,realName:'합성 회원',avatarUrl:null,bio:null,sweetness:15};
else if(pathname===`/conversations/${conversation}`){if(denyChat){status=403;code='FORBIDDEN';}else data=[{request_id:conversation,can_send:true,my_role:'requester',post_title:'합성 동행',post_id:peer,appointment_id:null,last_read_message_id:null,read_at:null,unread_count:0}];}
else if(pathname===`/conversations/${conversation}/messages`){if(req.method()==='POST'){if(postFailure==='delayed')await new Promise(resolve=>{releaseMessage=resolve;});if(typeof postFailure==='number'){status=postFailure;code=status===401?'AUTH_REQUIRED':status===403?'FORBIDDEN':status===409?'CONFLICT':status===410?'EXPIRED':'EXTERNAL_UNAVAILABLE';}else data={messageId:input.messageId,createdAt:now,alreadySent:false};}else if(denyChat){status=403;code='FORBIDDEN';}else data={items:[{messageId:u.searchParams.has('before')?'66666666-6666-4666-8666-666666666666':'55555555-5555-4555-8555-555555555555',senderId:peer,content:u.searchParams.has('before')?old:recent,createdAt:now}],nextCursor:u.searchParams.has('before')?null:'77777777-7777-4777-8777-777777777777'};}
else if(pathname===`/requests/${conversation}/consent`)data={consent:null};
else if(pathname==='/posts')data={status:'no_results',posts:[],nextCursor:null};
else if(pathname.endsWith('/feedback'))data={status:'not_enabled',reason:'AI_FEEDBACK_STORAGE_NOT_CONNECTED'};
else {external.push('UNEXPECTED_API:'+pathname);return route.abort();}
try{await route.fulfill({status,contentType:'application/json',body:JSON.stringify(status===200?{data,requestId:user}:{error:{code,retryable:true},requestId:user})});}catch(e){if(!/closed|cancel|invalid|not found|handled/i.test(String(e)))throw e;}
});
const click=name=>page.getByRole('button',{name,exact:true}).last().click();
const body=()=>page.locator('body').innerText();
const install=async view=>{await page.goto(base+'/night-test?view='+view);await page.getByText(`검증 소스 ${sourceHashes['RemoteScreens.tsx'].slice(0,12)} ${sourceHashes['RemoteMemberScreens.tsx'].slice(0,12)}`,{exact:true}).waitFor();await click('합성 세션 설치');await page.getByText(view==='chat'?recent:'공개된 카드로 추천을 안내해요. 실명·전화번호·상세 만남 위치는 입력하지 마세요.',{exact:false}).last().waitFor();};
const aiInput=()=>page.getByRole('textbox',{name:'찾고 싶은 동행과 지역을 알려 주세요',exact:true});
const aiCalls=()=>calls.filter(c=>c.path==='/ai-chat');
const messageCalls=()=>calls.filter(c=>c.path.endsWith('/messages')&&c.method==='POST');
const waitUntil=async(fn)=>{for(let i=0;i<100;i++){if(await fn())return;await page.waitForTimeout(20);}throw new Error('Condition deadline');};
const report=process.env.NIGHT_BROWSER_RESULT||'/private/tmp/night-remote-browser-result.json';
try{
await install('ai');aiMode='delayed';await aiInput().fill('질문 A');await click('보내기');await waitUntil(()=>!!releaseAi);await aiInput().fill('미전송 질문 B');releaseAi();releaseAi=null;await page.getByText('확인된 합성 결과 없음',{exact:true}).last().waitFor();record('AI 응답 대기 중 새로 쓴 입력 보존',await aiInput().inputValue()==='미전송 질문 B');
for(const reason of ['input_privacy','output_privacy','daily_limit','concurrent','consent','temporary']){aiMode=reason;await aiInput().fill('합성 요청 '+reason);const before=aiCalls().length;await click('보내기');await page.getByText('합성 중단 안내 '+reason,{exact:true}).waitFor();record('AI '+reason+' 중단 안내·입력 보존',await aiInput().inputValue()==='합성 요청 '+reason);record('AI '+reason+' 자동 재전송 없음',aiCalls().length===before+1);record('AI '+reason+' 실패를 0건으로 안내하지 않음',!(await body()).includes('조건에 맞는 결과가 없어요.'));
if(reason==='output_privacy'){const original=aiSequence;await click('답변 다시 확인하기');await waitUntil(()=>aiSequence>original);record('출력 재확인은 원 서버 요청 ID 연결',aiCalls().at(-1).input.outputRetryOf===`44444444-4444-4444-8444-${String(original).padStart(12,'0')}`);}}
const aiCount=aiCalls().length,postCount=calls.filter(c=>c.path==='/posts').length;await click('서울 전시');await waitUntil(()=>calls.filter(c=>c.path==='/posts').length>postCount);record('고정 조건 검색은 AI 요청을 만들지 않음',aiCalls().length===aiCount);
for(const mode of ['http401','http503']){aiMode=mode;await aiInput().fill('오류 입력 '+mode);const n=aiCalls().length;await click('보내기');await waitUntil(async()=>!(await page.getByRole('button',{name:'보내기',exact:true}).isDisabled()));record(mode+' 실패 입력 보존·자동재전송 없음',await aiInput().inputValue()==='오류 입력 '+mode&&aiCalls().length===n+1);}
aiMode='delayed';await aiInput().fill('새 대화 이전 요청');await click('보내기');await waitUntil(()=>!!releaseAi);await click('새 대화');releaseAi();releaseAi=null;await page.waitForTimeout(100);record('새 대화 뒤 늦은 응답을 표시하지 않음',!(await body()).includes('확인된 합성 결과 없음')&&await aiInput().inputValue()==='');
await install('chat');await click('이전 메시지 보기');await page.getByText(old,{exact:true}).waitFor();record('채팅 이전 페이지 fixture 정상 표시',(await body()).includes(old));denyChat=true;await click('검증 화면 나가기');await click('검증 화면 복귀');await page.getByText(/처리하지 못했어요|접근|권한/).last().waitFor();record('권한 회수 뒤 과거 페이지 본문 제거',!(await body()).includes(old)&&!(await body()).includes(recent));
await page.screenshot({path:path.join(temp,'chat-permission.png')});
denyChat=false;await install('chat');let field=page.getByRole('textbox',{name:'메시지',exact:true});
for(const status of [503,401,403,409,410]){postFailure=status;await field.fill('동일 의도 합성 입력');const before=messageCalls().length;await click('메시지 보내기');await waitUntil(()=>messageCalls().length>before);await waitUntil(()=>field.isEditable());record('메시지 '+status+' 실패 입력 보존·자동전송 없음',await field.inputValue()==='동일 의도 합성 입력'&&messageCalls().length===before+1);await click('새로고침');await page.getByText(recent,{exact:true}).waitFor();}
record('같은 메시지 수동 재시도는 같은 ID',new Set(messageCalls().map(c=>c.input.messageId)).size===1);
postFailure='delayed';await click('메시지 보내기');await waitUntil(()=>!!releaseMessage);await click('검증 화면 나가기');releaseMessage();releaseMessage=null;await page.waitForTimeout(100);await click('검증 화면 복귀');await page.getByText(recent,{exact:true}).waitFor();field=page.getByRole('textbox',{name:'메시지',exact:true});record('화면 밖 요청 종료 후 복귀시 로딩 해제',await field.isEditable());
await page.screenshot({path:path.join(temp,'chat-return.png')});
await install('ai');aiMode='delayed';await aiInput().fill('로그아웃 이전 합성 요청');await click('보내기');await waitUntil(()=>!!releaseAi);await click('합성 로그아웃');releaseAi();releaseAi=null;await page.waitForTimeout(100);record('로그아웃 뒤 늦은 AI 응답 미표시',!(await body()).includes('확인된 합성 결과 없음')&&(await body()).includes('검증 세션 없음'));
record('페이지 런타임 오류 없음',errors.length===0);record('실제 외부 요청 없음',external.length===0);record('모바일 가로 넘침 없음',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
}catch(error){errors.push(String(error));console.error((await body()).slice(-3500));await page.screenshot({path:path.join(temp,'failure.png')});}
finally{await browser.close();await new Promise(resolve=>server.close(resolve));await fs.writeFile(report,JSON.stringify({status:checks.every(c=>c.pass)&&errors.length===0&&external.length===0?'PASS':'FAIL',source,sourceHashes,temp,buildLog,checks,errors,external,requests:calls.length,scope:'Actual Expo web screens; synthetic HTTP/session only; no real server/provider/member/device'},null,2));console.log('RESULT',report);}
const saved=JSON.parse(await fs.readFile(report,'utf8'));if(!process.env.NIGHT_EXPECT_FAILURE)assert.equal(saved.status,'PASS');
