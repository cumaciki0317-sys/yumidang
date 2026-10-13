/* Presentation-only fixed scenes. Actions describe callbacks; they never process work. */
(() => {
 const $=s=>document.querySelector(s),toggle=$('#menu-toggle'),menu=$('#chat-menu'),dialog=$('#menu-preview'),input=$('.input-wrap input'),send=$('.send');
 const quick=document.createElement('div');quick.className='quick-actions';quick.setAttribute('role','group');quick.setAttribute('aria-label','빠른 메시지');
 ['안녕하세요!','네, 좋아요','어디서 만날까요?','감사합니다'].forEach(text=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.onclick=()=>{if(input.disabled)return;input.value=input.value.trim()?input.value+' '+text:text;input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();};quick.append(b);});$('.input-row').before(quick);
 const route=$('#notification-preview');$('.review-panel').append(route);route.className='review-status';
 const explain=text=>{route.textContent=text+' · 이벤트 연결 명세이며 실제 처리하지 않습니다.';};
 function closeMenu(){menu.hidden=true;toggle.setAttribute('aria-expanded','false');}
 toggle.onclick=()=>{menu.hidden=!menu.hidden;toggle.setAttribute('aria-expanded',String(!menu.hidden));};
 const mute=$('#mute-toggle');mute.onclick=()=>{const active=mute.getAttribute('aria-pressed')!=='true';mute.setAttribute('aria-pressed',String(active));mute.textContent=active?'알림 켜기':'알림 끄기';explain(active?'알림 끄기 표시 예시':'알림 켜기 표시 예시');};
 function positionMenuDialog(){positionDialog(dialog);}
 function positionDialog(dialog){if(!dialog.open)return;const r=$('.phone').getBoundingClientRect();const top=Math.max(0,r.top),bottom=Math.min(window.innerHeight,r.bottom);dialog.style.left=(r.left+r.width/2)+'px';dialog.style.top=((top+bottom)/2)+'px';dialog.style.width=Math.min(340,r.width-32)+'px';dialog.style.maxHeight=Math.max(120,bottom-top-32)+'px';}
 window.addEventListener('resize',positionMenuDialog);window.addEventListener('scroll',positionMenuDialog,{passive:true});
 function modal(title,text,action){const leaving=title==='대화방 나가기';dialog.classList.toggle('leave-dialog',leaving);$('#close-preview').textContent=leaving?'대화방 유지':'닫기';$('#menu-preview-title').textContent=title;dialog.querySelector('p').textContent=text;dialog.querySelector('[data-confirm-preview]')?.remove();if(action){const button=document.createElement('button');button.type='button';button.dataset.confirmPreview='';button.textContent=leaving||title==='보내지 않은 메시지가 있어요'?'나가기':title;button.onclick=()=>explain(action);if(leaving){$('#close-preview').before(button);}else{$('#close-preview').after(button);}}dialog.showModal();positionMenuDialog();}
 document.addEventListener('click',e=>{if(!e.target.closest('.header-actions'))closeMenu();const item=e.target.closest('[data-menu-action]');if(!item)return;closeMenu();const map={'신고':['상황 설명과 제출 가능한 캡처를 준비해 주세요. 신고 접수 후 내용을 검토해요.','신고 폼 열기 요청'],'차단':['차단은 접촉을 막고 확정 약속 취소와 별개입니다. 해제해도 종료된 신청은 자동 복원되지 않습니다.','차단 또는 해제 요청'],'대화방 나가기':['내 목록만 숨기며 상대 목록과 대화 기록은 유지합니다.','목록 숨김 요청']};const entry=map[item.dataset.menuAction];modal(item.dataset.menuAction,entry[0],entry[1]);});
 $('#close-preview').onclick=()=>dialog.close();dialog.addEventListener('close',()=>toggle.focus());document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu();});
 const postToggle=$('#post-toggle');postToggle.onclick=()=>{const open=postToggle.getAttribute('aria-expanded')!=='true';postToggle.setAttribute('aria-expanded',String(open));$('#post-card').hidden=!open;};
 $('.post-link').onclick=e=>{e.preventDefault();explain('공고 상세 열기 · 선택된 postId 전달');};
 const notice=document.createElement('p');notice.className='chat-state-notice';notice.setAttribute('role','status');$('.input-row').before(notice);
 const scenes={active:['대화 중','',false,true],first:['첫 메시지 전','첫 메시지를 보내면 동행 신청이 전달돼요.',false,false],failure:['전송 실패','',false,false],success:['첫 전송 성공 결과','',false,false],blocked:['차단됨','차단된 대화입니다. 기록 확인과 신고는 가능해요.',true,true],rejected:['신청 거절됨','신청이 거절되어 읽기 전용이에요.',true,true],ended:['모집 종료','모집이 종료되어 읽기 전용이에요.',true,true],withdrawn:['철회 후 대기','신청을 철회했어요. 아직 다시 신청할 수 없어요.',true,true],resubmit:['재신청 가능','메시지를 보내 다시 신청할 수 있어요.',false,true],deleted:['삭제된 공고','삭제된 공고의 대화는 읽기 전용이에요.',true,true],completed:['완료된 공고','완료된 공고의 대화는 읽기 전용이에요.',true,true],hostEmpty:['작성자 · 신청 없음','아직 받은 신청이 없어요.',true,false]};
 const review=document.createElement('section');review.innerHTML='<h3>대화 상태 예시</h3><p>버튼은 이벤트 설명만 표시합니다. 결과 상태는 직접 선택하세요.</p><label>상태 <select id="chat-state">'+Object.entries(scenes).map(([key,value])=>'<option value="'+key+'">'+value[0]+'</option>').join('')+'</select></label><p id="chat-route" role="status"></p>';$('.review-panel').append(review);
 const original=[...$('.messages').querySelectorAll('.message')];
 const entries=original.map((node,i)=>({sender:i===1?'applicant':'author',text:node.querySelector('.bubble').textContent,time:node.querySelector('time').textContent}));
 const result=document.createElement('article');result.hidden=true;$('.messages').append(result);
 const people={author:{name:'박지민',masked:'박**',age:29,sugar:99,photo:'../유미당-홈-소스/yumidang-home/assets/provided-profile-display.webp'},applicant:{name:'김수연',masked:'김**',age:27,sugar:17,photo:'../유미당-홈-소스/yumidang-home/assets/companion-profile.webp'}};
 function paintMessage(node,entry,viewer,confirmed){
  const own=entry.sender===viewer,person=people[entry.sender];node.className='message '+(own?'outgoing':'incoming');node.replaceChildren();
  if(!own){const avatar=document.createElement('img');avatar.className='avatar';avatar.src=person.photo;avatar.alt='상대 프로필 사진';node.append(avatar);}
  const content=document.createElement('div');content.className='message-content';
  if(!own){const sender=document.createElement('div');sender.className='sender';sender.textContent=(confirmed?person.name:person.masked)+(entry.sender==='author'?' · 작성자':'');content.append(sender);}
  const row=document.createElement('div');row.className='message-row';const bubble=document.createElement('p');bubble.className='bubble';bubble.textContent=entry.text;const time=document.createElement('time');time.textContent=entry.time;row.append(bubble,time);content.append(row);node.append(content);
 }
 function update(){
  const viewer=$('#flow-role')?.value||'author',author=viewer==='author',select=$('#chat-state');
  const applicantOnly=['first','resubmit'];
  [...select.options].forEach(option=>{option.disabled=author?applicantOnly.includes(option.value):option.value==='hostEmpty';});
  if(select.selectedOptions[0].disabled)select.value='active';
  const key=select.value,scene=scenes[key],hideAppointment=(key==='failure'&&!author)||['first','hostEmpty','rejected','ended','withdrawn','resubmit','deleted','completed','success'].includes(key),confirmed=!hideAppointment&&['confirmed','change','changeExpired','conflict','started'].includes($('#flow-preset')?.value),peer=people[author?'applicant':'author'];
  $('.partner-name').textContent=confirmed?peer.name:peer.masked;$('.age').textContent='(만 '+peer.age+'세)'+(author?' · 신청자':' · 작성자');$('.partner-photo').src=peer.photo;$('.sugar strong').textContent=peer.sugar;$('.sweetness-track>span').style.width=peer.sugar+'%';
  input.disabled=scene[2];quick.hidden=scene[2];send.disabled=scene[2]||!input.value.trim();notice.textContent=key==='rejected'&&author?'신청을 거절하여 읽기 전용이에요.':key==='withdrawn'&&author?'상대가 신청을 철회했어요. 대화는 읽기 전용이에요.':scene[1];if(key==='blocked'&&confirmed)notice.textContent=$('#flow-preset')?.value==='started'?'차단된 대화는 읽기 전용이에요. 기존 약속 확인과 중단·불발 신고는 가능해요.':'차단된 대화는 읽기 전용이에요. 기존 약속 확인·취소는 별도로 할 수 있어요.';notice.classList.toggle('is-error',key==='failure');
  original.forEach((node,i)=>{paintMessage(node,entries[i],viewer,confirmed);node.hidden=!(scene[3]||(key==='failure'&&author));});
  paintMessage(result,{sender:key==='failure'?viewer:'applicant',text:key==='failure'&&author?'네, 그럼 토요일 오후 2시에 뵐게요.':'안녕하세요. 함께 관람하고 싶어요.',time:key==='failure'&&author?'오후 2:35':'오후 2:30'},viewer,confirmed);result.hidden=!['success','failure'].includes(key);
  if(key==='failure'){
   result.querySelector('time').remove();
   const retry=document.createElement('button');retry.type='button';retry.className='retry-message';retry.setAttribute('aria-label','메시지 재전송');retry.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 5v6h-6M20 11a8 8 0 1 0-2 7"/></svg>';
   retry.onclick=()=>explain('실패한 메시지 재전송 요청 · 결과는 전송 성공/실패 장면에서 확인');
   result.querySelector('.message-row').append(retry);
   result.setAttribute('aria-label','전송 실패한 메시지');
  }else result.removeAttribute('aria-label');
  $('.messages .date').textContent='2026년 10월 13일 화요일';$('.messages .date').hidden=!scene[3]&&!['success','failure'].includes(key);
  const empty=key==='hostEmpty';$('.partner').hidden=empty;$('.partner-photo').hidden=empty;$('.header-actions').hidden=empty;
  const card=$('.flow-card');if(card)card.hidden=hideAppointment||(key==='blocked'&&!confirmed);
 }
 input.value='';input.oninput=()=>{send.disabled=input.disabled||!input.value.trim();};$('#chat-state').onchange=()=>window.chatDemo.renderFlow?window.chatDemo.renderFlow():update();
 send.onclick=()=>{if(send.disabled)return;explain('메시지 전송 요청 · 입력 유지. 전송 성공/실패 결과는 검토 패널에서 선택');};
 $('.topbar > button').onclick=()=>{if(['first','failure'].includes($('#chat-state').value)&&input.value.trim()){const firstApplication=$('#flow-role')?.value==='applicant';modal('보내지 않은 메시지가 있어요',firstApplication?'나가면 작성 중인 메시지가 사라지고 동행 신청은 전달되지 않아요.':'나가면 작성 중인 메시지가 사라져요.','입력 폐기 후 이전 화면 이동 요청');}else explain('이전 화면 이동 요청');};
 window.chatDemo={explain,update,positionDialog};update();
})();
