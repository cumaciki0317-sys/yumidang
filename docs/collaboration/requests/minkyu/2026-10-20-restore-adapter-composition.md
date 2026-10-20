# WBS7.14 복원 adapter·consumer 준비 연결

민규 harness: ownership_review 작성, root 코드/증거 검토. 전체79%(22/28) 유지. private 순수 준비 코드이며 실제 복원·closure executor·새 실행 authority를 제공하지 않는다. 현재 source121개 migration 및 과거 HEAD1d9에 고정한다. 실제 source가 바뀌면 새 고정 variant의 독립 검토가 필요하다.

`/private/tmp/yumidang-restore-adapter-composition-20261020/composer.py` SHA `1e3ac5408728901ce7b960319d7d7ea95f9053abe0e89c8133158ad13dee5451`, 영수증 `receipt.json` SHA `5d492d0e2427fcb608cfc5866df5831ccf0b572e9566a29d671e532ec77f4459`. 합성26회귀(정상2·거절24)가 통과했다. root는 전체184줄을 읽어 고정 consumer 필수 재호출·current121/11source 핀·capture6/역투영·원Auth6/binding/positive/seed·원baseline/intent/owned3·추가target단1개 delta의 준비 연결을 확인했다. 이 읽기 검토는 새26개 재실행 또는 실제 복원 결과가 아니다.

고정 consumer 결과를 우회해 SimpleNamespace.own을 호출하지 않는다. 원packet bytes를 수정하거나 자기 현재 상태를 원승인 baseline으로 바꾸지 않는다. 반환은 runnable=false/executionAllowed=false/committedHeadVerified=false이고 실제 파일/디렉터리·글로벌 intent를 생성하지 않는다. 한국어 Env에서 metadata/resource SHA의 직렬화 차이도 합성 회귀로 구분한다.

이 연결은 실제 Docker identity/StartedAt/network와 현재 메모리1GiB/768MiB·3초감시, 원full178/role·ACL·sequence·UNKNOWN 실비교, 원source당 O_EXCL intent, 실제 capture/restore/정지 dispatcher를 대체하지 않는다. source.dump archive를 새로복원하거나 TOC를 다시 추출하지 않았고 historical FAIL은 실제 PASS로 바꾸지 않는다. actualDocker/SQL/HTTP0·fullRestore=false다.

다음 작업은 승인된3파일 로컬커밋 뒤 finalHEAD variant 고정 → 새 Auth6/positive·내정보 실제4case·원3600초 자연만료 검증 → 원seed/capture6/새target proof와 현재보존비교 → 별도실제adapter/closure 연결이다. 현재 stopped a002/b003를 재시작하거나 과거 intent를 재사용하지 않는다. Storage45 metadata·기확보6파일과 미확보39원본은 계속 구분한다. 이 준비26개를 전체복원 완료나 기존producer61/consumer23/실제121검증에 합산하지 않는다.
