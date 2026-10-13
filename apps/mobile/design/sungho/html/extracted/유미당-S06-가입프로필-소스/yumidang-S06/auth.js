
'use strict';
const $=s=>document.querySelector(s);let photo='',selected={taste:[],talk:[]},mbti=['','','',''];
// Local presentation validation and completion preview only; no account, upload or persistence.
let photoObjectUrl=null,photoEpoch=0;
const presets={taste:['지금이당','전시','축제','팝업','공연','영화','맛집','카페','쇼핑','여행','운동','산책','게임','반려동물','스터디'],talk:['활발함','차분함','에너지 넘침','잘 들어요','깊은 대화','가벼운 수다','천천히 친해져요']};
const icons={back:'<path d="m15 5-7 7 7 7"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>',camera:'<path d="M3 8h4l2-3h6l2 3h4v12H3z"/><circle cx="12" cy="13" r="4"/>',shield:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6z"/><path d="m8 12 3 3 5-6"/>'};
const ico=n=>'<svg viewBox="0 0 24 24" aria-hidden="true">'+icons[n]+'</svg>';
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function header(title,back=false){return '<header class="top"><button class="icon-button" data-action="'+(back?'back':'exit')+'" aria-label="'+(back?'뒤로':'닫기')+'">'+ico(back?'back':'close')+'</button><h1>'+title+'</h1><span class="spacer"></span></header>'}
const reviewStates={default:'프로필 입력',photoMissing:'사진 미등록 오류',photoFormat:'지원하지 않는 사진 형식',photoSize:'10MB 초과',photoFailure:'사진 선택 실패',photoReady:'예시 사진 선택',tagLimit:'성향 20개 제한',tagLength:'성향 40자 제한',tagDuplicate:'성향 중복 오류',tagWhitespace:'성향 공백 오류',tagControl:'성향 입력 문자 오류',mbtiPartial:'MBTI 일부 선택',saving:'가입 처리 중',saveError:'가입 저장 실패',completionRequired:'사진 선택 후 완료 전',complete:'가입 완료 안내 팝업'};
function render(){const state=$('#scenario').value||'default';$('#app').innerHTML=signup();$('#scenario').innerHTML=Object.entries(reviewStates).map(([value,label])=>'<option value="'+value+'">'+label+'</option>').join('');$('#scenario').value=state;refreshPreferences();$('#demo-title').textContent='S06 · 가입 프로필';}
function tagSection(kind,title,placeholder){return '<section class="section tag-section"><div class="section-heading"><h3>'+title+'<span class="optional">선택</span></h3><span class="count" id="'+kind+'-count">0 / 20</span></div><div class="chips" id="'+kind+'-chips"></div><div class="add-row"><input class="input" id="'+kind+'-input" aria-label="'+title+' 직접 입력" aria-describedby="'+kind+'-error" placeholder="'+placeholder+'"><button class="add-tag" data-add="'+kind+'">추가</button></div><p class="hint">최대 20개 · 항목당 40자</p><p class="error" id="'+kind+'-error" role="alert"></p></section>'}
function signup(){return header('프로필 등록',true)+'<main class="main signup-main"><section class="signup-note"><p>사진은 필수, 취향과 성향은 선택이에요.</p></section><section class="section photo-section"><div class="section-heading"><h3>프로필 사진<span class="required">필수</span></h3></div><div class="photo-area"><button class="photo-button" data-action="photo" aria-label="프로필 사진 선택" aria-describedby="photo-error">'+(photo?'<img src="'+photo+'" alt="선택한 프로필 사진">':ico('camera'))+'</button><button class="secondary photo-select-button" data-action="photo" aria-describedby="photo-error">'+(photo?'사진 변경':'사진 선택')+'</button><p class="hint">JPG·JPEG·PNG · 원본 10MB 이하</p></div><p class="error" id="photo-error" role="alert"></p><input hidden type="file" id="photo-input" aria-describedby="photo-error" accept="image/jpeg,image/png,.jpg,.jpeg,.png"></section><div class="form-divider" role="separator"></div>'+tagSection('taste','관심사','직접 적어서 추가')+'<div class="form-divider" role="separator"></div>'+tagSection('talk','대화 방식','나만의 대화 방식')+'<div class="form-divider" role="separator"></div><section class="section"><div class="section-heading"><h3>MBTI<span class="optional">선택</span></h3><button class="text-button" data-action="mbti-clear">비우기</button></div><div class="mbti" id="mbti" aria-describedby="mbti-error"></div><p class="hint">네 쌍을 모두 선택하거나 비워두세요.</p><p class="error" id="mbti-error" role="alert"></p></section><section class="ai-note"><p>AI 가입 동의 방식은 법적 확인 중이에요. 이 미리보기에서 필수 AI 동의로 가입을 막거나 실제 회원 정보를 외부로 보내지 않아요.</p></section></main><footer class="footer"><button class="primary" data-action="complete"'+(!photo?' disabled aria-disabled="true"':'')+'>가입 완료</button></footer>'}
function refreshPreferences(){for(let k of ['taste','talk']){let all=[...new Set([...presets[k],...selected[k]])];$('#'+k+'-chips').innerHTML=all.map(v=>'<button class="chip" aria-pressed="'+selected[k].includes(v)+'" data-kind="'+k+'" data-tag="'+esc(v)+'">'+esc(v)+'</button>').join('');$('#'+k+'-count').textContent=selected[k].length+' / 20'}$('#mbti').innerHTML=[['I','E'],['S','N'],['T','F'],['J','P']].map((p,i)=>'<div class="mbti-pair" role="group" aria-label="'+p.join(' 또는 ')+'">'+p.map(v=>'<button class="chip" aria-pressed="'+(mbti[i]===v)+'" data-mbti="'+i+'" data-value="'+v+'">'+v+'</button>').join('')+'</div>').join('');}
let priorFocus;function modal(title,text,label,action='dismiss',symbol='✓'){priorFocus=document.activeElement;$('#dialog').innerHTML='<div class="state-symbol">'+symbol+'</div><h2 id="dialog-title">'+title+'</h2><p>'+text+'</p><button class="primary" data-action="'+action+'">'+label+'</button>';$('#modal').hidden=false;$('#app').inert=true;$('.preview-controls').inert=true;$('#dialog button').focus()}
function closeModal(){$('#modal').hidden=true;$('#app').inert=false;$('.preview-controls').inert=false;if(priorFocus?.isConnected&&!priorFocus.disabled)priorFocus.focus();else $('#scenario').focus()}
function setError(id,text){$(id).textContent=text;const controls={'#photo-error':['#photo-input','.photo-button','.photo-select-button'],'#taste-error':['#taste-input'],'#talk-error':['#talk-input'],'#mbti-error':['#mbti']};for(const selector of controls[id]||[])$(selector).setAttribute('aria-invalid','true');$(id).scrollIntoView({block:'center',behavior:'smooth'})}
function addTag(k){const input=$('#'+k+'-input');const value=input.value.trim();if(!value)return;if(value.length>40){setError('#'+k+'-error','항목당 40자까지 입력할 수 있어요.');return;}if(selected[k].includes(value)){setError('#'+k+'-error','이미 추가한 항목이에요.');return;}if(selected[k].length>=20){setError('#'+k+'-error','최대 20개까지 선택할 수 있어요.');return;}$('#'+k+'-error').textContent='';input.removeAttribute('aria-invalid');selected[k].push(value);input.value='';refreshPreferences();}
document.addEventListener('click',event=>{const button=event.target.closest('button');if(!button||button.disabled)return;const data=button.dataset;
 if(data.tag){const k=data.kind,v=data.tag;if(!selected[k].includes(v)&&selected[k].length>=20){setError('#'+k+'-error','최대 20개까지 선택할 수 있어요.');return;}selected[k]=selected[k].includes(v)?selected[k].filter(x=>x!==v):[...selected[k],v];refreshPreferences();return;}
 if(data.add){addTag(data.add);return;}
 if(data.mbti!==undefined){mbti[Number(data.mbti)]=data.value;refreshPreferences();return;}
 if(data.action==='photo')$('#photo-input').click();
 if(data.action==='mbti-clear'){mbti=['','','',''];$('#mbti-error').textContent='';$('#mbti').removeAttribute('aria-invalid');refreshPreferences();}
 if(data.action==='dismiss')closeModal();
 if(['complete','signup-home','back','exit'].includes(data.action)){
  if(data.action==='signup-home')closeModal();
  $('#action-note').textContent='Expo 연결 이벤트: '+({complete:'가입 프로필 제출', 'signup-home':'완료 후 홈',back:'이전 화면',exit:'닫기'}[data.action])+'. 결과는 상태 선택에서 확인합니다.';
 }

});
document.addEventListener('keydown',event=>{if(event.key==='Enter'&&['taste-input','talk-input'].includes(event.target.id)){event.preventDefault();addTag(event.target.id.split('-')[0]);}if(!$('#modal').hidden&&event.key==='Tab'){event.preventDefault();$('#dialog button').focus();}if(!$('#modal').hidden&&event.key==='Escape'){event.preventDefault();closeModal();}});
document.addEventListener('change',event=>{if(event.target.id!=='photo-input')return;const file=event.target.files[0];if(!file)return;
 // Match Expo original-photo input errors before local display; never upload.
 if(file.size>10000000){setError('#photo-error','원본 10MB 이하의 사진을 선택해 주세요.');return;}
 if(file.type?!['image/jpeg','image/png'].includes(file.type):!/\.(jpe?g|png)$/i.test(file.name)){setError('#photo-error','JPG·JPEG·PNG 형식의 사진을 선택해 주세요.');return;}
 const epoch=++photoEpoch,nextUrl=URL.createObjectURL(file),image=new Image();
 image.onload=()=>{if(epoch!==photoEpoch){URL.revokeObjectURL(nextUrl);return;}if(photoObjectUrl)URL.revokeObjectURL(photoObjectUrl);photoObjectUrl=nextUrl;photo=nextUrl;const pending={taste:$('#taste-input').value,talk:$('#talk-input').value};render();for(const k of ['taste','talk'])$('#'+k+'-input').value=pending[k];};
 image.onerror=()=>{URL.revokeObjectURL(nextUrl);if(epoch!==photoEpoch)return;setError('#photo-error','사진을 읽지 못했어요. 다른 사진으로 다시 시도해 주세요.');};
 image.src=nextUrl;
});
function reviewState(value){
 ++photoEpoch; // Review states supersede any pending local image display.
 closeModal();
 if(value==='default'){photo='';selected={taste:[],talk:[]};mbti=['','','',''];}
 if(['photoReady','completionRequired','saving','saveError','complete'].includes(value))photo='assets/companion-profile.webp';
 if(value==='photoMissing')photo='';
 if(value==='tagLimit')selected.taste=Array.from({length:20},(_,i)=>'예시 관심사 '+(i+1));
 if(value==='mbtiPartial')mbti=['I','','',''];
 render();$('#scenario').value=value;
 const errors={photoMissing:['#photo-error','프로필 사진은 필수예요.'],photoFormat:['#photo-error','JPG·JPEG·PNG 형식의 사진을 선택해 주세요.'],photoSize:['#photo-error','원본 10MB 이하의 사진을 선택해 주세요.'],photoFailure:['#photo-error','사진을 선택하지 못했어요. 다시 시도해 주세요.'],tagLimit:['#taste-error','최대 20개까지 선택할 수 있어요.'],tagLength:['#taste-error','항목당 40자까지 입력할 수 있어요.'],tagDuplicate:['#taste-error','이미 선택한 항목이에요. 대소문자만 다른 항목도 중복이에요.'],tagWhitespace:['#taste-error','연속된 공백 없이 입력해 주세요.'],tagControl:['#taste-error','사용할 수 없는 제어 문자를 제거해 주세요.'],mbtiPartial:['#mbti-error','MBTI를 모두 선택하거나 비워 주세요.']};
 if(errors[value])setError(...errors[value]);
 if(value==='saving'){const button=$('[data-action=complete]');button.disabled=true;button.setAttribute('aria-busy','true');button.textContent='처리 중…';}
 if(value==='saveError')modal('가입을 완료하지 못했어요','입력한 내용은 그대로 있어요. 잠시 후 다시 시도해 주세요.','확인','dismiss','!');
 if(value==='complete')modal('가입을 완료했어요','유미당에서 나에게 맞는 동행을 찾아보세요.','홈으로 이동','signup-home');
}
$('#modal').addEventListener('click',event=>{if(event.target===$('#modal'))closeModal();});
$('#scenario').addEventListener('change',event=>reviewState(event.target.value));
render();
