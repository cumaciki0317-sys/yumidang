import {test}from 'node:test';
import assert from 'node:assert/strict';
import {createServiceApi}from '../../../backend/supabase/functions/service-api/handler.ts';
import {HttpError}from '../../../backend/supabase/functions/_shared/http/errors.ts';
const id='11111111-1111-4111-8111-111111111111';
test('공개 행사 상세와 순위 보류는 정해진 조회 RPC만 호출하고 잘못된 토큰을 익명으로 바꾸지 않는다',async()=>{
 const calls:string[]=[];let auth=0;
 const handler=createServiceApi({allowedOrigins:[],maxBodyBytes:4096,authenticateUser:async()=>{throw new Error('unexpected');},authenticateInternal:async()=>{throw new Error('unexpected');},publicEvents:{authenticate:async r=>{auth++;if(r.headers.has('authorization'))throw new HttpError('AUTH_REQUIRED');return{caller:'anonymous',db:{rpc:async name=>{calls.push(name);return{status:'not_enabled'};}}};},execute:async()=>{throw new Error('unexpected');},filters:async()=>{throw new Error('unexpected');}}});
 const send=(path:string,method='GET',headers={})=>handler(new Request('https://api.example.invalid/service-api'+path,{method,headers}));
 assert.equal((await send('/events/'+id)).status,200);assert.equal((await send('/events/rankings')).status,200);
 assert.equal((await send('/events/'+id,'GET',{authorization:'Bearer invalid'})).status,401);
 for(const path of ['/events/bad','/events/'+id+'?userId='+id])assert.equal((await send(path)).status,400);
 assert.equal((await send('/events/'+id,'POST')).status,405);
 assert.deepEqual(calls,['get_public_event','get_public_event_ranking_state']);assert.equal(auth,3);
});
