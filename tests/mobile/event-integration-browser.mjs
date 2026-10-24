/** Real Expo web screens with intercepted synthetic HTTP; no real service/member/provider traffic. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
const source=path.resolve(process.env.EVENT_INTEGRATION_SOURCE_ROOT||path.join(import.meta.dirname,'../..'));
const actual=path.resolve(import.meta.dirname,'../../apps/mobile');
const require=createRequire(path.join(actual,'package.json'));
const {chromium}=require('playwright');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'yumidang-event-integration-browser-'));
const app=path.join(temp,'apps/mobile'),output=path.join(temp,'web');
await fs.mkdir(app,{recursive:true});
await fs.cp(path.join(source,'apps/mobile/src'),path.join(app,'src'),{recursive:true});
for(const name of ['package.json','app.json','tsconfig.json','metro.config.js'])await fs.copyFile(path.join(source,'apps/mobile',name),path.join(app,name));
await fs.symlink(path.join(actual,'node_modules'),path.join(app,'node_modules'),'dir');
await fs.symlink(path.join(actual,'assets'),path.join(app,'assets'),'dir');
await fs.symlink(path.join(source,'backend'),path.join(temp,'backend'),'dir');
const sourceHashes={};
for(const name of ['screens/RemoteScreens.tsx','screens/RemoteMemberScreens.tsx','screens/BrowseScreens.tsx','api.ts','service.ts','member-service.ts','event-contract.ts','remote.tsx','state.tsx','storage.ts','presentation/events/EventPresentation.tsx'])sourceHashes[name]=createHash('sha256').update(await fs.readFile(path.join(app,'src',name))).digest('hex');
await fs.appendFile(path.join(app,'metro.config.js'),`\nmodule.exports.cacheVersion = ${JSON.stringify(temp)};\n`);
const eid='10000000-0000-4000-8000-000000000001',pid='20000000-0000-4000-8000-000000000001';
await fs.writeFile(path.join(app,'src/app/event-integration-test.tsx'),`import React from 'react';
import {View,Text} from 'react-native';
import {useLocalSearchParams} from 'expo-router';
import {RemoteEventDetail,RemotePostDetail} from '../screens/RemoteScreens';
export default function Test(){const {view}=useLocalSearchParams();return <View style={{flex:1}}><Text>합성 행사·공고 HTTP 화면 검증</Text>{view==='post'?<RemotePostDetail id="${pid}"/>:<RemoteEventDetail id="${eid}"/>}</View>;}`);
const env={...process.env,EXPO_OFFLINE:'1',CI:'1',EXPO_NO_TELEMETRY:'1',EXPO_PUBLIC_DATA_MODE:'service',EXPO_PUBLIC_SERVICE_API_URL:'https://api.synthetic.test/service-api',EXPO_PUBLIC_AI_CHAT_URL:'https://api.synthetic.test/ai-chat'};
const buildLog=path.join(temp,'export.log');
await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(actual,'node_modules/expo/bin/cli'),'export','--platform','web','--output-dir',output],{cwd:app,env});let log='';child.stdout.on('data',c=>{log+=c;});child.stderr.on('data',c=>{log+=c;});child.on('error',reject);child.on('close',async code=>{await fs.writeFile(buildLog,log);code===0?resolve():reject(Error('Expo export failed: '+log.slice(-3500)));});});
const mime={'.js':'application/javascript','.css':'text/css','.html':'text/html','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.ttf':'font/ttf','.woff2':'font/woff2','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{try{const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);let file=path.resolve(output,'.'+pathname);if(!file.startsWith(output+path.sep)&&file!==output){res.writeHead(403);return res.end();}try{if(!(await fs.stat(file)).isFile())file=path.join(output,'index.html');}catch{file=path.join(output,'index.html');}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream'});res.end(await fs.readFile(file));}catch{res.writeHead(500);res.end();}});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
const base='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/Users/b/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'});
const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);
const checks=[],errors=[],external=[],calls=[],screenshots=[];
let listMode='normal',linkMode='manual',moreFails=true;
const event={id:eid,provider:'kopis',sourceId:'synthetic-event',sourceStatus:'active',title:'합성 공개 행사',category:'공연',region:'서울특별시',placeName:'합성 공연장',publicAddress:'서울특별시 종로구 세종대로',admission:{kind:'unknown'},sourceUrl:null,collectedAt:'2026-10-24T00:00:00Z',state:'upcoming',precision:'date',startsOn:'2099-11-01',endsOn:'2099-11-03',description:'외부 API를 사용하지 않는 합성 행사입니다.',operatingInfo:null,posterUrl:null};
const card=(n,recruiting=false)=>({id:`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`,title:`${recruiting?'모집중':'전체'} 합성 공고 ${n}`,authorDisplayName:null,publicArea:'서울특별시 종로구 사직동',startsAt:'2099-11-01T01:00:00Z',endsAt:'2099-11-01T02:00:00Z',cost:{kind:'free'},state:recruiting||n%2?'recruiting':'closed',canApply:false});
const detail=()=>({postId:pid,title:'합성 동행 공고',description:'행사 상태와 관계없이 유지할 공개 공고 본문',category:'공연',startsAt:'2099-11-01T01:00:00Z',endsAt:'2099-11-01T02:00:00Z',recruitmentEndsAt:'2099-11-01T00:00:00Z',updatedAt:'2026-10-24T00:00:00Z',publicArea:'서울특별시 종로구 사직동',status:'recruiting',costType:'free',amount:0,preferenceNote:null,tags:[],eventId:['hidden','linked'].includes(linkMode)?eid:null,linkedEvent:linkMode==='linked'?event:null,authorDisplayName:null});
const link=()=>({postId:pid,eventId:['hidden','linked'].includes(linkMode)?eid:null,manualEvent:linkMode==='manual'?{title:'직접 입력 합성 클래스',placeName:'합성 공방',publicAddress:'서울특별시 종로구 공개 행사장',publicAddressConfirmed:true}:null,linkedEvent:linkMode==='linked'?event:null,eventLinkState:linkMode});
const check=(name,value)=>{checks.push({name,pass:!!value});console.log(value?'PASS':'FAIL',name);assert.ok(value,name);};
page.on('pageerror',e=>errors.push(e.message));
await page.route('**/*',async route=>{const req=route.request(),u=new URL(req.url());if(u.origin===base)return route.continue();if(u.origin!=='https://api.synthetic.test'){external.push(u.origin);return route.abort();}
 const pathname=u.pathname.replace('/service-api','');calls.push({path:pathname,query:Object.fromEntries(u.searchParams),method:req.method()});let data,status=200;
 if(pathname===`/events/${eid}`)data=event;
 else if(pathname==='/posts'){
   if(listMode==='unsupported'){status=400;}else if(listMode==='empty')data={status:'no_results',posts:[],nextCursor:null};
   else if(u.searchParams.has('cursor')){if(moreFails)status=503;else data={status:'results',posts:[card(11)],nextCursor:null};}
   else{const r=u.searchParams.get('availability')==='recruiting';data={status:'results',posts:r?[card(1,true)]:Array.from({length:10},(_,i)=>card(i+1)),nextCursor:r?null:'synthetic_page_2'};}
 }else if(pathname===`/posts/${pid}`)data=detail();
 else if(pathname===`/posts/${pid}/event-link`){if(linkMode==='failure')status=503;else data=link();}
 else{external.push('UNEXPECTED_API:'+pathname);return route.abort();}
 await route.fulfill({status,contentType:'application/json',body:JSON.stringify(status===200?{data}:{error:{code:status===400?'INVALID_REQUEST':'EXTERNAL_UNAVAILABLE'}})});
});
const click=name=>page.getByRole('button',{name,exact:true}).last().click();
const body=()=>page.locator('body').innerText();
const screenshot=async name=>{const file=path.join(temp,name+'.png');await page.screenshot({path:file,animations:'disabled'});screenshots.push(file);};
const visit=async view=>page.goto(base+'/event-integration-test?view='+view);
const report=process.env.EVENT_INTEGRATION_BROWSER_RESULT||'/private/tmp/yumidang-event-integration-browser-result.json';
try{
 await visit('event');await page.getByText('전체 합성 공고 10',{exact:true}).waitFor();
 const first=calls.find(c=>c.path==='/posts');check('행사 상세는 exact 행사 ID·전체·등록 최신순·10개를 요청',first.query.eventId===eid&&first.query.availability==='all'&&first.query.sort==='created_desc'&&first.query.limit==='10'&&!('query'in first.query));
 check('익명 공고는 작성자 정보를 노출하지 않음',(await body()).includes('동행인은 로그인 후 확인할 수 있어요'));
 await click('공고 10개 더 보기');await page.getByText('추가 공고를 불러오지 못했어요',{exact:true}).waitFor();
 check('추가 조회 실패에도 기존 공고 유지',(await body()).includes('전체 합성 공고 1')&&!(await body()).includes('아직 이 행사에 등록된 동행 공고가 없어요'));
 await screenshot('event-posts-more-failure');moreFails=false;await click('다시 시도');await page.getByText('전체 합성 공고 11',{exact:true}).waitFor();
 const more=calls.filter(c=>c.path==='/posts'&&c.query.cursor);check('추가 조회 수동 재시도는 같은 커서를 사용',more.length===2&&more[0].query.cursor===more[1].query.cursor);
 await click('모집 중');await page.getByText('모집중 합성 공고 1',{exact:true}).waitFor();check('모집 중 필터 변경은 이전 목록·커서를 초기화',!(await body()).includes('전체 합성 공고 11')&&calls.filter(c=>c.path==='/posts').at(-1).query.availability==='recruiting'&&!calls.filter(c=>c.path==='/posts').at(-1).query.cursor);
 await screenshot('event-posts-recruiting');
 listMode='unsupported';await visit('event');await page.getByText('연결된 공고를 확인하지 못했어요',{exact:true}).waitFor();check('미지원 서버 필터를 0건으로 표시하지 않음',!(await body()).includes('아직 이 행사에 등록된 동행 공고가 없어요'));
 listMode='empty';await click('다시 시도');await page.getByText('아직 이 행사에 등록된 동행 공고가 없어요',{exact:true}).waitFor();check('성공한 빈 응답만 0건 안내',true);
 linkMode='manual';await visit('post');await page.getByText('직접 입력 합성 클래스',{exact:true}).waitFor();check('직접 입력 행사를 공고 내부에서 표시',(await body()).includes('합성 공방')&&await page.getByRole('button',{name:'행사 정보 보기',exact:true}).count()===0);await screenshot('post-manual-event');
 linkMode='hidden';await visit('post');await page.getByText('연결된 행사 정보를 현재 제공할 수 없어요',{exact:true}).waitFor();check('비표출 원천에서도 공고·중립 안내 유지',(await body()).includes('행사 상태와 관계없이 유지할 공개 공고 본문')&&(await body()).includes('행사 취소를 의미하지는 않아요')&&!(await body()).includes('합성 공개 행사'));await screenshot('post-hidden-event');
 linkMode='linked';await visit('post');await page.getByRole('button',{name:'행사 정보 보기',exact:true}).waitFor();check('원천 행사 상세 이동과 원천 카드 표시',(await body()).includes('합성 공개 행사'));
 linkMode='failure';await visit('post');await page.getByText('행사 정보를 확인하지 못했어요',{exact:true}).waitFor();check('행사 조회 실패는 공고를 유지하며 이전 원천 정보 제거',(await body()).includes('행사 상태와 관계없이 유지할 공개 공고 본문')&&!(await body()).includes('합성 공개 행사'));await screenshot('post-event-failure');
 linkMode='none';await click('다시 시도');await page.getByText('행사 정보를 확인하지 못했어요',{exact:true}).waitFor({state:'hidden'});await page.getByText('연결된 행사 정보를 확인하고 있어요…',{exact:true}).waitFor({state:'hidden'});check('연결 없음 응답은 행사 영역 생략',await page.getByRole('button',{name:'행사 정보 보기',exact:true}).count()===0&&!(await body()).includes('연결된 행사 정보를 확인하고 있어요'));
 check('모바일 가로 넘침 없음',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 check('실제 외부 요청·런타임 오류 없음',external.length===0&&errors.length===0);
}catch(error){errors.push(String(error));console.error((await body()).slice(-3500));await screenshot('failure');}
finally{await browser.close();await new Promise(resolve=>server.close(resolve));await fs.writeFile(report,JSON.stringify({status:checks.every(c=>c.pass)&&checks.length>0&&!errors.length&&!external.length?'PASS':'FAIL',source,sourceHashes,temp,buildLog,screenshots,checks,errors,external,calls,scope:'Actual Expo web render with synthetic intercepted HTTP. Server eventId filtering/DB/provider/member/native operation not verified.'},null,2));console.log('RESULT',report);}
assert.equal(JSON.parse(await fs.readFile(report,'utf8')).status,'PASS');
