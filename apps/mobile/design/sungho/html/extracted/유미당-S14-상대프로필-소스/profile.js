/* Fixed presentation scenes. Server-provided visibility and values are not calculated here. */
(() => {
  const $ = selector => document.querySelector(selector);
  const scene = $('#scene'), summaryState = $('#summary-state'), content = $('#profile');
  const note = text => { $('#event').textContent = text + ' · 연결 이벤트만 표시합니다. 결과는 검토 패널에서 선택하세요.'; };
  const userIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg>';
  const reviews = [
    ['이*정','10월 12일','5','좋아요','만나기 전에 전시 정보를 함께 찾아주셨어요. 각자 보고 싶은 작품을 편하게 보다가 이야기 나눌 수 있어서 좋았어요.',['배려심이 있어요','대화가 즐거워요']],
    ['박*연','10월 9일','5','좋아요','약속 시간보다 조금 먼저 와 계셨고, 장소도 알기 쉽게 알려주셨어요. 다음에도 함께하고 싶어요.',['시간을 잘 지켜요','소통이 원활해요']],
    ['정*아','10월 5일','4','좋아요','처음 만났는데도 편안하게 산책했어요. 걷는 속도를 맞춰주셔서 고마웠어요.',['함께하니 편안해요']],
    ['최*빈','9월 28일','4','보통이에요','일정대로 전시를 관람했어요.',[]],
    ['윤*진','9월 20일','5','좋아요','',['약속한 내용을 지켜요']],
    ['한*서','9월 14일','5','좋아요','취향이 비슷해서 대화가 즐거웠어요.',['대화가 즐거워요']]
  ];
  const tags = values => values.map(text => '<span class="tag">'+text+'</span>').join('');
  const praiseEmoji = {'시간을 잘 지켜요':'⏰','약속한 내용을 지켜요':'🤝','소통이 원활해요':'💬','배려심이 있어요':'💛','대화가 즐거워요':'☕','함께하니 편안해요':'🌿'};
  const praiseTags = values => values.map(text => '<span class="tag"><span class="praise-emoji" aria-hidden="true">'+praiseEmoji[text]+'</span><span>'+text+'</span></span>').join('');
  function empty(title, description, action) { return '<div class="empty">'+userIcon+'<h2>'+title+'</h2><p>'+description+'</p>'+(action?'<button class="primary" data-event="'+action+'">'+(action==='S05 로그인 화면 열기'?'로그인하고 확인하기':'다시 시도')+'</button>':'')+'</div>'; }
  function reviewCards(anonymous, more) {
    const shown = reviews.map((r,index) => scene.value==='negative' && index===3 ? [r[0],r[1],'2','별로예요','일정 변경 안내가 늦어 아쉬웠어요.',[]] : r);
    return shown.slice(0, more ? 6 : 5).map((r,index) => '<article class="card review"><div class="review-author">'+(anonymous?'<div class="review-avatar anonymous" aria-hidden="true">'+userIcon+'</div>':'<div class="review-avatar" role="img" aria-label="'+r[0]+' 프로필 사진" style="background-position:'+['0 0','100% 0','0 100%','100% 100%','100% 0','0 100%'][index]+'"></div>')+'<div class="review-author-info"><strong>'+(anonymous?'익명':r[0])+'</strong>'+(anonymous?'':'<span>당도 <b>'+[19,25,21,18,23,20][index]+'</b></span>')+'</div><time>'+r[1]+'</time></div><div class="row review-rating"><span class="stars" aria-label="별점 '+r[2]+'점">'+'★'.repeat(Number(r[2]))+'☆'.repeat(5-Number(r[2]))+'</span><span class="mood '+(r[3]==='좋아요'?'positive':r[3]==='보통이에요'?'neutral':'negative')+'">'+r[3]+'</span></div>'+(r[4]&&(anonymous||summaryState.value!=='insufficient'||index<2)?'<p>'+r[4]+'</p>':'')+'<div class="tags">'+praiseTags(r[5])+'</div></article>').join('');
  }
  function summaryMarkup(isNew) {
    const state = isNew ? 'insufficient' : summaryState.value;
    const summaryHeader = '<details class="card summary-card"><summary><span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z"/></svg>AI 후기 요약</span><svg class="chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></summary>';
    if(state==='ready') return summaryHeader+'<p class="small">공개된 글 후기를 바탕으로 정리했어요.</p><p class="summary-copy">약속 시간을 잘 지키고, 만남 전 장소와 일정을 꼼꼼하게 공유한다는 후기가 있어요. 상대의 관람 속도를 배려하고 편안하게 대화를 나누는 점이 자주 언급돼요.</p></details>';
    const messages={pending:'공개된 후기를 정리하고 있어요.',error:'후기 요약을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.',insufficient:'공개된 글 후기 3개부터 요약을 준비해요.',withdrawn:'후기 요약 사용이 철회되어 요약을 제공하지 않아요.',hidden:'공개 가능한 후기가 변경되어 요약을 다시 준비하고 있어요.'};
    return summaryHeader+'<p class="summary-copy">'+messages[state]+'</p>'+(state==='error'?'<button class="more" data-event="후기 요약 재조회 요청">다시 시도</button>':'')+'</details>';
  }
  function render() {
    const key=scene.value, restricted=['guest','blocked','withdrawn','loading','error'].includes(key), isNew=key==='new';
    $('#menu').hidden=true;$('#more').setAttribute('aria-expanded','false');$('.menu-anchor').hidden=restricted||key==='own';summaryState.disabled=restricted||isNew;
    if(key==='guest'){content.innerHTML='<div class="empty"><div class="placeholder" aria-hidden="true"></div><h2>동행인은 로그인 후 확인할 수 있어요</h2><p>프로필과 공개된 후기를 확인해 보세요.</p><button class="primary" data-event="S05 로그인 화면 열기">로그인하고 확인하기</button></div>';return;}
    if(key==='blocked'){content.innerHTML=empty('프로필을 확인할 수 없어요','차단 관계에서는 프로필을 볼 수 없어요. 기존 약속은 약속 화면에서 확인해 주세요.');return;}
    if(key==='loading'){content.innerHTML='<div role="status" aria-label="프로필 불러오는 중">'+Array(3).fill('<div class="skeleton" aria-hidden="true"><i></i><i></i><i></i></div>').join('')+'</div>';return;}
    if(key==='error'){content.innerHTML=empty('프로필을 불러오지 못했어요','잠시 후 다시 시도해 주세요.','프로필 재조회 요청');return;}
    if(key==='withdrawn'){content.innerHTML=empty('탈퇴한 사용자입니다.','기존 공개 후기는 익명으로 유지돼요.')+'<h2 class="section-title">공개 후기 <span>6개</span></h2>'+reviewCards(true,false)+'';return;}
    const score=key==='negative'?'21':'26';
    const name=['confirmed','own'].includes(key)?'김수미':'김*미';
    const traits=key==='sparse'?'<p class="muted">아직 등록한 성향이 없어요.</p>':'<div class="conversation-traits"><p class="trait-label">대화 스타일</p><div class="tags conversation-tags">'+tags(['차분한 대화','잘 들어주는 편'])+'</div></div><div class="interest-traits"><p class="trait-label">함께 즐기고 싶은 것</p><div class="tags interests">'+tags(['전시','카페','산책'])+'</div></div>';
    const praiseNames=['대화가 즐거워요','배려심이 있어요','시간을 잘 지켜요','소통이 원활해요','함께하니 편안해요','약속한 내용을 지켜요'];
    const praise=praiseNames.slice(0,5).map((name,i)=>'<div class="praise"><div class="row"><span><span aria-hidden="true">'+praiseEmoji[name]+'</span> '+name+'</span><strong>'+(isNew?0:[2,1,1,1,1,1][i])+'회</strong></div><div class="track" aria-hidden="true"><i style="width:'+(isNew?0:[100,50,50,50,50,50][i])+'%"></i></div></div>').join('');
    content.innerHTML='<section class="card"><div class="identity"><div class="profile-photo-group"><div class="portrait-ring" style="--sweetness:'+(isNew?15:score)+'">'+(key==='photoError'?'<div class="portrait photo-error" role="img" aria-label="프로필 사진을 불러오지 못함">'+userIcon+'</div>':'<div class="portrait" role="img" aria-label="'+name+' 프로필 사진"></div>')+'</div></div><div class="profile-name"><div class="profile-name-line"><h2>'+name+'</h2><p class="muted">만 27세'+(key==='sparse'?'':' · INFP')+'</p></div><p class="profile-sweetness">당도 <strong>'+(isNew?'15':score)+'</strong></p></div><div class="profile-history"><p>동행 <strong>'+(isNew?'0':'8')+'회</strong> 완료</p><button class="review-jump" type="button">'+(key==='reviewError'?'후기 보기 ↓':'후기 '+(isNew?'0':'6')+'개 ↓')+'</button></div></div>'+(key==='photoError'?'<p class="small" role="status">프로필 사진을 확인하지 못했어요.</p>':'')+''+(isNew?'<p class="small">아직 평가가 없는 초기 당도 15예요.</p>':'')+'<div class="traits profile-traits">'+traits+'</div></section>'+summaryMarkup(isNew)+'<h2 class="section-title">함께한 사람이 남긴 칭찬</h2><section class="card">'+praise+'</section><h2 id="reviews-heading" tabindex="-1" class="section-title">동행 후기 <span>'+(key==='reviewError'?'—':isNew?'0':'6')+'개</span></h2>'+(key==='reviewLoading'?'<section class="card" role="status"><p class="muted">후기를 불러오고 있어요…</p></section>':key==='reviewError'?'<section class="card"><p class="muted">후기를 불러오지 못했어요.</p><button class="more" data-event="공개 후기 재조회 요청">다시 시도</button></section>':isNew?'<section class="card"><p class="muted">아직 공개된 후기가 없어요.</p><p class="small">후기는 실제 동행 완료 후 양쪽이 제출하거나 작성 기한이 끝나면 공개돼요.</p></section>':reviewCards(false,key==='moreReviews')+(key==='moreLoading'?'<p class="review-load" role="status" aria-busy="true">후기를 더 불러오고 있어요…</p>':key==='moreError'?'<div class="review-load" role="status"><p>후기를 불러오지 못했어요.<br>위로 조금 올렸다가 다시 내려 주세요.</p><button class="review-retry" data-event="공개 후기 추가 조회 재시도">다시 시도</button></div>':key==='moreReviews'?'':''));
    content.querySelector('.review-jump')?.addEventListener('click',()=>{const target=content.querySelector('#reviews-heading');target?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});target?.focus({preventScroll:true});});
    content.querySelector('details')?.addEventListener('toggle',e=>{if(e.target.open)note('요약 펼침 · 서버의 최신 공개 조건 및 요약 조회 요청');});
  }
  document.addEventListener('click',e=>{const action=e.target.closest('[data-event]');if(action){note(action.dataset.event);$('#menu').hidden=true;$('#more').setAttribute('aria-expanded','false');}else if(!e.target.closest('.menu-anchor')){$('#menu').hidden=true;$('#more').setAttribute('aria-expanded','false');}});
  $('#more').onclick=()=>{const open=$('#menu').hidden;$('#menu').hidden=!open;$('#more').setAttribute('aria-expanded',String(open));};
  function blockState(){const state=$('#block-state').value;$('#confirm-block').disabled=state==='busy';$('#confirm-block').textContent=state==='busy'?'처리 중…':state==='error'?'다시 시도':'차단하기';$('#confirm-block').setAttribute('aria-busy',String(state==='busy'));$('#block-feedback').hidden=state!=='error';$('#block-feedback').textContent=state==='error'?'차단하지 못했어요. 잠시 후 다시 시도해 주세요.':'';}
  $('#block-state').onchange=()=>{blockState();$('#confirm').showModal();};
  $('#block').onclick=()=>{$('#menu').hidden=true;$('#more').setAttribute('aria-expanded','false');blockState();$('#confirm').showModal();};
  $('#close').onclick=()=>$('#confirm').close();$('#confirm-block').onclick=()=>{$('#confirm').close();note('차단 요청 · 대상 profileId 전달');};$('#confirm').addEventListener('close',()=>$('#more').focus());
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){$('#menu').hidden=true;$('#more').setAttribute('aria-expanded','false');}});
  scene.onchange=()=>{$('#event').textContent='';render();};summaryState.onchange=render;render();
})();
