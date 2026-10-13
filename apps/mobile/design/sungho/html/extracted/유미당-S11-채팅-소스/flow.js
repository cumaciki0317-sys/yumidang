/* Fixed presentation scenes, independent of app state/domain/time. */
(() => {
 const $=s=>document.querySelector(s),card=document.createElement('section');card.className='flow-card';card.setAttribute('aria-label','동행 약속 관리');$('.chat-context').append(card);
 const scenes={conversation:'대화 중',pending:'확정 요청 대기',expired:'확정 요청 만료',confirmed:'확정',change:'변경 제안 대기',changeExpired:'변경 제안 만료',conflict:'일정 충돌',cancelled:'취소',started:'시작 이후'};
 const review=document.createElement('section');review.className='flow-review';review.innerHTML='<h3>약속 상태 예시</h3><p>시간 계산·업무 처리는 하지 않습니다. 역할과 결과 장면을 직접 선택합니다.</p><label>내 역할<select id="flow-role"><option value="author">작성자</option><option value="applicant">신청자</option></select></label><label>화면 장면<select id="flow-preset">'+Object.entries(scenes).map(([key,value])=>'<option value="'+key+'">'+value+'</option>').join('')+'</select></label><label>변경 제안자<select id="flow-proposer"><option value="self">내가 제안</option><option value="peer">상대가 제안</option></select></label><label>입력 피드백<select id="flow-validation"><option value="normal">기본 입력</option><option value="error">입력 오류 표시 예시</option></select></label>';$('.review-panel').append(review);
 const dialog=document.createElement('dialog');dialog.className='flow-dialog';document.body.append(dialog);let returnFocus;
 function form(title,fields,event){dialog.classList.remove('flow-confirm');dialog.removeAttribute('style');returnFocus=document.activeElement;dialog.innerHTML='<form novalidate><h2>'+title+'</h2>'+fields+'<p class="flow-error" role="alert">'+($('#flow-validation').value==='error'?'입력한 일정·장소 또는 사유를 확인해 주세요.':'')+'</p><div class="flow-actions"><button type="button" data-close>닫기</button><button type="submit">요청 보내기</button></div></form>';dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.querySelector('form').onsubmit=e=>{e.preventDefault();dialog.querySelector('.flow-error').textContent=$('#flow-validation').value==='error'?'입력한 일정·장소 또는 사유를 확인해 주세요.':'';if($('#flow-validation').value!=='error')window.chatDemo.explain('요청 이벤트: '+event+' · 입력 유지. 결과는 검토 패널에서 선택');};dialog.showModal();}
 dialog.addEventListener('close',()=>returnFocus?.focus());
 function positionConfirmation(){if(dialog.open&&dialog.classList.contains('flow-confirm'))window.chatDemo.positionDialog(dialog);}
 function confirmAction(key){
  returnFocus=document.activeElement;const reject=key==='rejectApplication';
  const title=reject?'신청을 거절할까요?':'확정 요청을 보낼까요?';
  const body=reject?'거절하면 이 신청은 종료되며, 상대는 같은 공고에 다시 신청할 수 없어요.':'상대가 요청을 수락하면 동행이 확정돼요. 대화에서 일정과 장소를 합의했는지 확인해 주세요.';
  const action=reject?'신청 거절':'확정 요청 보내기';
  const confirm='<button type="button" class="flow-primary" data-confirm>'+action+'</button>';
  const cancel='<button type="button" data-close autofocus>'+(reject?'신청 유지':'취소')+'</button>';
  dialog.classList.add('flow-confirm');dialog.innerHTML='<h2>'+title+'</h2><p>'+body+'</p><div class="flow-actions">'+(reject?confirm+cancel:cancel+confirm)+'</div>';
  dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  dialog.querySelector('[data-confirm]').onclick=()=>{dialog.close();window.chatDemo.explain('이벤트: '+action+' · 결과 장면을 검토 패널에서 선택하세요.');};
  dialog.showModal();positionConfirmation();
 }
 window.addEventListener('resize',positionConfirmation);window.addEventListener('scroll',positionConfirmation,{passive:true});

 const button=(key,text)=>'<button type="button" data-flow="'+key+'">'+text+'</button>';
 function render(){const scene=$('#flow-preset').value,author=$('#flow-role').value==='author';let title=scenes[scene],body='',buttons='';
  if(scene==='conversation'){title=author?'일정과 장소를 정하셨나요?':'대화하며 동행을 준비해요';body=author?'상대가 수락하면 동행이 확정돼요.':'작성자의 확정 요청을 수락하면 동행이 확정돼요.';buttons=author?button('rejectApplication','신청 거절')+button('request','확정 요청 보내기'):button('withdrawApplication','신청 철회');}
  if(scene==='pending'){body='수락 마감: 10월 17일 14:00 · 마감 시각부터 수락 불가';buttons=author?button('withdraw','요청 철회'):button('reject','요청 거절')+button('accept','수락하고 확정');}
  if(scene==='expired')body='확정 요청이 만료됐어요. 신청과 대화는 유지됩니다.';
  if(['confirmed','change','changeExpired','conflict','started'].includes(scene)){body='10월 17일 14:00–16:00 · 국립현대미술관 서울<br>서울 종로구 삼청로 30 · 정문 안내 데스크 앞';buttons=button('appointment','약속 상세 보기');}
  if(scene==='confirmed'||scene==='changeExpired')buttons+=button('cancel','동행 취소')+button('propose','일정·장소 변경');
  if(scene==='changeExpired')body+='<br>변경 제안이 만료됐어요. 기존 약속을 유지합니다.';
  if(scene==='change'){body+='<div class="flow-proposal">변경 제안: 10월 17일 15:00–17:00 · 서울숲<br>서울 성동구 뚝섬로 273 · 정문 안내 데스크 앞<br>수락 마감: 10월 17일 14:00 · 수락 전까지 기존 약속 유지</div>';buttons+=$('#flow-proposer').value==='self'?button('withdrawChange','제안 철회'):button('rejectChange','변경 거절')+button('acceptChange','변경 수락');}
  if(scene==='conflict')body+='<br>기존 확정 약속과 겹쳐 수락할 수 없어요. 기존 약속은 유지됩니다.';
  if(scene==='cancelled')body='동행이 취소됐어요. 상대의 이름과 상세 만남 위치는 더 이상 볼 수 없어요. 모집은 자동 재개되지 않습니다.';
  if(scene==='started'){body+='<br>시작 이후에는 중단·불발 신고를 이용해 주세요.';buttons+=button('report','중단·불발 신고');}
  if($('#chat-state').value==='blocked'&&['confirmed','change','changeExpired','conflict','started'].includes(scene)){body+='<br>차단과 별개로 기존 약속은 유지됩니다.';buttons=button('appointment','약속 상세 보기')+(scene==='started'?button('report','중단·불발 신고'):button('cancel','동행 취소'));}
  card.dataset.scene=scene;
  card.classList.toggle('flow-status-only',!buttons);
  card.innerHTML=(!buttons?'<div class="flow-status" role="status"><strong>'+title+'</strong><div>'+body+'</div></div>':(scene==='conversation'?'':'<div class="flow-summary"><h3>'+title+'</h3><div>'+body+'</div></div>')+'<div class="flow-actions">'+buttons+'</div>');window.chatDemo.update();
 }
 card.onclick=e=>{const key=e.target.closest('[data-flow]')?.dataset.flow;if(!key)return;
  if(key==='request'||key==='rejectApplication')return confirmAction(key);
  if(key==='propose')return form('일정·장소 변경 제안','<p>상대 수락 전까지 기존 약속 유지</p><label>시작<input type="datetime-local" name="start" value="2026-10-17T14:00"></label><label>예상 종료<input type="datetime-local" name="end" value="2026-10-17T16:00"></label><label>등록 장소<select name="place"><option>국립현대미술관 서울</option><option>서울숲</option><option>여의도 한강공원</option></select></label>','변경 제안 요청');
  if(key==='cancel'||key==='withdrawApplication')return form(key==='cancel'?'동행 취소':'신청 철회','<label>사유<select name="reason"><option>선택해 주세요</option><option>개인 사정</option><option>일정 착오</option><option>기타</option></select></label>',key==='cancel'?'동행 취소 요청':'신청 철회 요청');
  if(key==='report')return form('중단·불발 신고','<label>상황 설명<textarea rows="4"></textarea></label><p>접수와 위반 확정은 구분됩니다.</p>','중단·불발 신고 화면 요청');
  window.chatDemo.explain('이벤트: '+e.target.textContent+' · 결과 장면을 검토 패널에서 선택하세요.');
 };
 window.chatDemo.renderFlow=render;$('#flow-role').onchange=render;$('#flow-preset').onchange=render;$('#flow-proposer').onchange=render;render();
})();
