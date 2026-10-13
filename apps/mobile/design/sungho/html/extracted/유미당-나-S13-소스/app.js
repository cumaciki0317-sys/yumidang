/* Design only: switch among reviewed, fixed example views. No policy, authentication, API, filtering or date engine. */
const $=s=>document.querySelector(s);
let viewerId='me',tab='내 동행';
function render(){
 const view=VIEWS[viewerId]||VIEWS[''];
 $('#content').innerHTML=view[tab].replaceAll('@@peer@@',ASSETS.peer).replaceAll('@@avatar@@',ASSETS.avatar);
 $('#preview-viewer').value=viewerId;
}
document.addEventListener('click',event=>{const b=event.target.closest('button');if(!b)return;if(b.dataset.action==='toggle-sweetness-info'){const open=b.getAttribute('aria-expanded')!=='true';b.setAttribute('aria-expanded',String(open));$('#sweetness-description').hidden=!open;return}if(b.dataset.tab){tab=b.dataset.tab;render()}if(b.dataset.dest){let notice=$('#destination-preview');if(!notice){notice=document.createElement('p');notice.id='destination-preview';notice.setAttribute('role','status');document.querySelector('.demo').append(notice)}const labels={S00:'홈',S01:'둘러보기',S10:'대화 목록',S11:'대화방',S03:'공고 작성',S05:'로그인',S14:'공개 프로필',S15:'프로필 사진', 'S15-2':'취향·성향',S16:'약속 상세',S17:'후기 작성',S19:'안심 동행 수칙',S21:'계정 상태'};notice.textContent=b.dataset.runtimeAction==='logout'?'로그아웃 요청 → 성공 시 홈 이동. 실제 로그아웃은 실행하지 않습니다.':`${labels[b.dataset.dest]||b.dataset.dest} · ${b.dataset.dest}${b.dataset.id?' / '+b.dataset.id:''} 연결 대상입니다. 현재는 화면 이동 예시 안내이며 실제 이동은 하지 않습니다.`;}});
$('#preview-viewer').onchange=event=>{viewerId=event.target.value;tab='내 동행';render();$('#content').scrollTop=0};
render();
