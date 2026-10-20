from pathlib import Path
import json,hashlib,subprocess,re,collections,os
B=Path(__file__).resolve().parent;R=B.parents[4]
def load(name):return json.loads((B/name).read_text())
policy=load('policy-units.json');client=load('client-audit.json');server=load('server-audit.json');qa=load('qa-design.json');decisions=load('decision-records.json')
raw=load('document-inventory.json');rule=json.loads((R/'backend/ownership.json').read_text())
def owner(p):
 a=[v for v in rule['rules'] if p.startswith(v['path'])] # exact path verification below
 a=[v for v in a if v['path'].endswith('/') or v['path']==p]
 return max(a,key=lambda v:len(v['path']))['owner'] if a else 'minkyu'
def mapped_owner(o):
 if o in ('minkyu','jonghyun','yumi','공통'):return o
 s=str(o)
 who=[v for k,v in [('민규','minkyu'),('종현','jonghyun'),('유미','yumi')] if k in s]
 return who[0] if len(who)==1 else '공통'
groups=client['groups']+server['groups']
for g in groups:g['owner']=mapped_owner(g['owner']);g['evidence_level']='정적 소스 대조';g['runtime_status']='NOT_RUN'
for c in qa['cases']:c['owner']=mapped_owner(c['owner'])
for g in qa['gates']:g['owner']=mapped_owner(g['owner'])
units=policy['units']
for u in units:
 u['group_ids']=[g['id'] for g in groups if u['id'] in g['policy_ids']]
 u['case_ids']=[c['id'] for c in qa['cases'] if u['id'] in c['policy_ids']]
 u['gate_ids']=[g['id'] for g in qa['gates'] if u['id'] in g['policy_ids']]
 u['scope']='현재 제외' if u['chapter']=='12' else '확인 과제/플랫폼별 조건' if u['chapter']=='0' else '현재 정책에 따른 포함·조건'
 u['qa_note']='직접 사례에 연결' if u['case_ids'] else '상위 출시 조건의 자료·범위 점검으로 연결; 독립 실행 통과를 뜻하지 않음'
changes={};scanned={}
for name in ['root-doc-sync.json','client-doc-sync.json','server-doc-sync.json']:
 j=load(name)
 for rec in j.get('changes',[]):changes[rec['path']]=rec
 for rec in j.get('files',[]):
  p=rec.get('path')
  if p:
   scanned[p]=rec
   if rec.get('before_sha256')!=rec.get('after_sha256'):changes[p]=rec
 for rec in j.get('apps_html',[]):
  if isinstance(rec,dict) and rec.get('path'):scanned[rec['path']]=rec;changes[rec['path']]=rec
# Actual current diff, not an agent count, decides which original documents are changed.
changed=set(subprocess.check_output(['git','diff','--name-only','-z','72be7fb'],cwd=R).decode().split('\0'))
documents=[]
for p in raw['tracked_documents']:
 fp=R/p
 retired=raw.get('retired_documents',{}).get(p)
 if retired:
  documents.append({'path':p,'owner':owner(p),'kind':'사용자 요청으로 삭제','changed':True,'reason':retired['reason'],'retired':retired,'before_committed_sha256':retired['sha256'],'after_sha256':None,'topics':[]})
  continue
 s=fp.read_text();is_user='작성본' in p
 current=p in {'정책.md','PLAN.md','PLAN_상세설계.md','AGENTS.md','README.md','docs/planning/requirements/PRD.md','docs/planning/design/IA.md','docs/planning/design/USERFLOW.md','docs/collaboration/README.md','docs/collaboration/team-start.md','docs/collaboration/jonghyun.md','docs/collaboration/minkyu.md','docs/planning/ut/README.md','tools/local/README.md','apps/mobile/README.md'} or p.startswith('backend/contracts/') or p in {'backend/README.md','backend/API_INPUT.md','backend/supabase/functions/_shared/ai/Agents/README.md'}
 if is_user:kind='원본 선택 증거 보존';reason='사용자가 작성한 원본 선택값·의견·내장 데이터는 바꾸지 않고 현재 정책 원장과 결정 기록에 연결했다.'
 elif p.endswith('AGENTS.md') and p.startswith('apps/'):kind='기술 일반 지침 보존';reason='Expo 개발 기술 지침이며 제품 정책 값을 정의하지 않는다. 루트 최신 정책이 적용된다.'
 elif p in changed and current:kind='현재 안내·요구사항 동기화';reason='최신 확정 정책을 현재 안내에 반영하고 실제 코드/운영 미완료와 구분했다.'
 elif p in changed:kind='과거 기록·시안의 현행 기준 연결';reason='과거 결과·선택·레이아웃은 보존하고 현재 정책/담당/미검증 조건을 명시했다.'
 else:kind='대조 후 원문 보존';reason='기술 설명 또는 기존 검증 증거다. 현재 정책을 대체하는 실행 지시로 사용하지 않으며 관련 현재 안내/원장에 연결한다.'
 if p in scanned:reason=scanned[p].get('reason',scanned[p].get('note',reason)) or reason
 try:old=subprocess.check_output(['git','show','72be7fb:'+p],cwd=R,stderr=subprocess.DEVNULL);oldhash=hashlib.sha256(old).hexdigest()
 except subprocess.CalledProcessError:oldhash=None
 documents.append({'path':p,'owner':owner(p),'kind':kind,'changed':p in changed,'reason':reason,'before_committed_sha256':oldhash,'after_sha256':hashlib.sha256(fp.read_bytes()).hexdigest(),'topics':[label for label,ks in [('AI·동의',['AI','요약','동의']),('공급사·비용',['Gemini','포텐스','예산']),('행사·순위',['KOPIS','행사','TourAPI']),('운영·역할',['신고','탈퇴','담당'])] if any(k in s for k in ks)]})
questions=[]
for source in [client,server,qa]:
 for q in source.get('questions',[]):
  if q['id'] not in [x['id'] for x in questions]:questions.append(q)
summary=[
 '가입 후기 AI 선택3종·전체 동의·독립 철회는 화면/서버 저장 계약에 미구현 차이가 있어 담당별 후속으로 연결했습니다.',
 'KOPIS 최신 A안·14분류와 기존2분류/basedate필수 구현의 차이를 확인했습니다. 일반 행사 개발과 기간 대조는 독립 진행합니다.',
 '직접 입력 행사는 공고 전용 정책이 확정됐지만 실제 서버 저장·비표출/동일 행사 통합/연결 공고 표시는 후속 구현·연동이 남아 있습니다.',
 '포텐스닷 회신 수신·Gemini 테스트 월 예산·합성3건 및 대표 계정 전환 대기를 현재 문서에 구분했습니다.',
 '출시 조건·QA 사례는 실행 설계입니다. 신규 실제 서버·회원·실기기·운영 검증 PASS를 생성하지 않았습니다.',
 '종현 브랜치의 원본 문서 경로를 담당별 정상 커밋으로 통합하고 원격 HEAD/내용까지 별도 검증합니다.'
]
model={'schema_version':1,'date':'2026-10-20','baseline':'72be7fb7a4af3d24770ea11f3f9e255e85326ccd','authority':'최신 사용자 답변 및 정책.md','policy_sha256':policy['sha256'],'summary':summary,'units':units,'groups':groups,'gates':qa['gates'],'cases':qa['cases'],'decisions':decisions['records'],'documents':documents,'questions':questions,'boundaries':load('harness.json')['boundaries'],'qa_execution':'본 작업은 설계/정적 대조다. 새 제품 테스트·외부 호출·회원 검증·운영 적용은 NOT_RUN.','coverage_notes':{'client':client['coverage_notes'],'server':server['coverage_notes'],'qa':qa['coverage_notes']}}
model['fingerprint']=hashlib.sha256(json.dumps(model,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
(B/'audit.json').write_text(json.dumps(model,ensure_ascii=False,indent=2)+'\n')
data=json.dumps(model,ensure_ascii=False,separators=(',',':')).replace('<','\\u003c')
html=(B/'review-template.html').read_text().replace('__AUDIT_DATA__',data)
html=html.replace('<option>jonghyun</option><option>minkyu</option><option>yumi</option>','<option value="jonghyun">종현</option><option value="minkyu">민규</option><option value="yumi">유미</option>')
html=html.replace("pill(x.classification,x.classification==='일치'?'good':'warn')", "pill('정적 대조: '+x.classification,x.classification==='일치'?'good':'warn')")
(B/'index.html').write_text(html)
name={'jonghyun':'종현','minkyu':'민규','yumi':'유미','공통':'공통'}
md=['# 확정 정책·구현 대조와 전체 문서 동기화', '', '2026-10-20 / 종현 / AI 지원 작성·자체 교차검토. 실제 팀원의 작업·합의·실행으로 보고하지 않는다.', '', '[통합 HTML 검토판](index.html) · [전체 원장](audit.json) · [현재 정책](../../../../../정책.md)', '', '## 작업 개요', '', '- 작업일: 2026-10-20', '- 대상 브랜치: `jonghyun/policy-review-20261017`', '- 기준 리비전: `72be7fb7a4af3d24770ea11f3f9e255e85326ccd`', '- 범위: WBS1.1·1.2·1.3·1.4·6.1; 관련 문서 전체, 담당 구역과 관계없이 동기화 및 원본 경로 원격 반영.', '- 환경: 독립 로컬 clone, 제품 소스 읽기/기존 증거 대조. 신규 DB/공급사/실회원/기기/운영 실행0.', '- 원본 사용자 선택 HTML5개는 바이트 보존. 기존 중간 후보 복제본29개는 현재 기준에서 제외하며 원래 문서 경로의 최종 내용을 반영한다.', '', '## 목표와 판정 경계', '']
md+=['- '+s for s in summary]
md+=['',f"정책 원문 대조 항목{len(units)}개(중복·표 제목 포함), 클라이언트{len(client['groups'])}·서버{len(server['groups'])} 묶음, 출시 조건{len(qa['gates'])}·QA 사례{len(qa['cases'])}개다. 이 숫자는 서로 다른 정책 수나 제품 통과 수가 아니다.", '', '## 현재 포함·제외·보류', '', '| 영역 | 확정 범위 | 검증·후속 경계 |', '|---|---|---|', '| 무료 동행 | 여성·만19세 이상, 네이버 단독, 무료1:1, 첫 메시지 신청→확정→완료→후기 | 실제 회원·서버·다중 기기·분쟁/권한 QA 별도 |', '| 공고·행사 | 선택 행사 연결, 공고 전용 직접 입력, 3공급사 연동 목표 | 서버 저장/등록 검사/비표출/통합·HTTPS 수집 미완료를 목표 제외로 바꾸지 않음 |', '| KOPIS | A안·14분류·최근7일·분류별 공식 대조 후 공개 | 미검증 분류 공식 링크, 일반 행사 기능과 분리 |', '| AI | 탐색 첫 사용 동의, 후기 가입 선택3종·전체 동의, 철회 후 일반 동행 유지 | 공급사·동의·삭제 확인 전 실회원 전송 HOLD, AI 신고 운영 준비 전 비활성 |', '| 공급사·비용 | Potens 교육/프로토타입; Gemini 종현 테스트·월50,000원 사용중단 예산 | 실제 청구 상한 보장·서버 원화 원장·대표 전환은 별도 확인 |', '| 플랫폼 | Android 독립 설치 검증 목표 | Apple 계정/서명 필요한 배포는 보류, 계정 없이 가능한 설계는 계속 |', '| 현재 제외 | 유료 동행·결제/정산/계좌인증·학교/직장인증·친구/초대·관리자 행사등록·안심통화·외부캘린더 등 정책12장 | 외부 행사 입장료와 동행 유료화를 혼동하지 않음 |', '', '## TASK별 산출물·완료 조건', '', '| TASK | 이번 산출물 | 완료와 구분할 것 |', '|---|---|---|', '| 1.1 | 전 정책 범위·제외·보류 및 구현 묶음 연결 | 범위 검토가 기능 구현 완료는 아님 |', '| 1.2 | 정책/화면/소스/증거/담당/WBS/다음 행동·수용 기준 | 정적 소스 일치가 실제 운영 PASS는 아님 |', '| 1.3 | 원본 선택65건·최신 결정10건의 근거 보존·승계 | 과거 미정·필수 동의를 현재 미정/필수로 복원하지 않음 |', '| 1.4 | 출시 조건28개·필요 증거·미충족 영향·기존 정책/합의 경계 | 실제 팀 출시 합의·승인은 아직 없음 |', '| 6.1 | 실행 환경·역할·사전 조건·단계·예상/금지 결과·증빙·정리70사례 | QA 실행·회원/기기 PASS는 생성하지 않음 |', '', '## 구현 차이와 다음 담당', '']
for g in groups:
 md += [f"### {g['id']} · {g['title']}", '', f"- 정적 대조: **{g['classification']}** / 다음 담당: {name[g['owner']]} / WBS {', '.join(g['wbs'])}", '- 정책: '+g['policy_summary'], '- 구현 확인: '+g['actual'], '- 다음 작업: '+g['next_action'], '- 해결 후 기준: '+g['acceptance'], '- 정책 항목: '+', '.join(g['policy_ids'])]
 for r in g.get('source_refs',[]):md.append(f"- 구현 근거: [{r['note']}]({os.path.relpath(R/r['path'],B)}) (`{r['path']}`의 정적 코드)")
 md.append('')
md+=['## 검증·미실행·한계', '', '- 이번 산출물 검증: 원장 참조·정책 연결·소스 경로/행·문서 분류·HTML 구문/실제 브라우저·선택/저장 기능·정상 소유권 commit·원격 내용 대조를 검증 기록에 남긴다.', '- 과거 night32+기존49와 Expo웹37, 행사20/프리뷰14, Gemini합성3건은 각각 당시 환경·소스 범위로만 재사용한다. 서로 더해 제품 전체 통과 수를 만들지 않는다.', '- 실제 OAuth·회원·운영DB·새 공급사 호출·모델/비용·실기기·배포 검증은 이번에 실행하지 않았다.', '- 기존 2026-10-14 결정에 따라 탐색 자동 재시도는 미전송 확인 경우만 동일 요청 전체1회다. 전송 후/불명 오류는 자동 재전송하지 않는다. 클라이언트 버튼 재전송과 서버 내부 처리 재시도를 구분했다.', '', '## 마지막 확인 질문', '', f"새 정책 선택 질문: {len(questions)}개. 이미 확정한 내용을 다시 묻지 않는다. 구현·외부 조건은 선택으로 완료할 수 없으므로 해당 묶음/출시 조건의 담당과 증거로 추적한다.", '', '## 문서 동기화·커밋·원격 반영', '', f"원래 문서 경로{len(documents)}개를 대조했다. 현재 git diff로 변경된 문서{sum(d['changed'] for d in documents)}개이며, 사용자가 작성한 원본 선택 HTML5개 및 기술·검증 원자료는 분류·현재 기준 연결과 함께 보존한다.", '', '- 파일별 기록은 [문서 원장](audit.json)의 documents와 root/client/server-doc-sync.json 참조.', '- 공유 clone과 actor/hook/ownership은 유지한다. 원래 owner별 독립 clone의 검사·commit을 종현 브랜치에 순차 통합한다.', '- 최신 사용자 승인 범위는 문서 및 원격 반영이며 제품 코드·DB·운영·main/민규 브랜치 병합으로 확대하지 않는다.', '- commit·push·최종 원격 증거는 [원격 반영 영수증](remote-verification.json)에 기록한다. 해당 영수증의 실제 결과 전에는 원격 완료로 읽지 않는다.', '', '## 후속 담당', '', '- 종현: 클라이언트50묶음 중 확정 정책 미구현·UX·연동·합성 QA 후속. 날짜 입력 UX 재설계는 별도 작업이다.', '- 민규: 서버53묶음의 계약·DB·공급사/비용/운영 후속. 코드 소유권은 이번 문서 작업으로 바꾸지 않았다.', '- 유미/팀: 출시 조건 검토·실제 지원/접근/삭제/공급사·플랫폼 증빙과 최종 출시 판단. 실제 검토 완료를 대신 기록하지 않는다.', '']
(B/'README.md').write_text('\n'.join(md))
print(json.dumps({'groups':len(groups),'units':len(units),'gates':len(qa['gates']),'cases':len(qa['cases']),'documents':len(documents),'changed_documents':sum(d['changed'] for d in documents),'questions':len(questions),'fingerprint':model['fingerprint']},ensure_ascii=False))
