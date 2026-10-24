# Router 디코더 보안 보완 설계

SDK57과 Router57을 유지한다. query-string7의 CommonJS 호출 계약은 유지하되 Metro에서 decode-uri-component 요청만 공식 수정판0.5.1 npm 별칭과 callable 어댑터로 연결한다. 기존 resolver 위임과 공유 backend watchFolder를 보존한다. 공급사 소스를 복사하거나 node_modules를 직접 패치하지 않는다.

실제 parse 호출은 expo-router/build/react-navigation/core/getStateFromPath.js에 있다. build/fork/getStateFromPath.js의 같은 호출은 주석이다. 번들 포함만으로 모든 앱 경로의 악용 가능성을 단정하지 않는다.

검증: query-string 실제 parse의 정상 한글/emoji/plus/중복/빈값/잘못된 인코딩, 긴 비정상 입력 종료, Metro Android·web graph에서 구 디코더 제거, lint/typecheck. 기존 APK는 수정 전 아티팩트로 보존하고 새 번들 검증 후 재생성한다. CLI 취약점은 별개이며 npm audit 전체 해소로 표시하지 않는다.

공식 근거: https://github.com/advisories/GHSA-vcc3-ghjq-m6fr · https://docs.expo.dev/guides/customizing-metro/

의존성은 기존 공유 node_modules를 변경하지 않고 이 clone의 별도 트리에서 설치한다. 서버/인증 정책·배포·서명은 변경하지 않는다.

## 1차 구현 결과

공식 별칭0.5.1 설치, Metro resolver와 src/safe-decode-uri.cjs 적용. package-lock 차이는 새 별칭 항목만이다. 실제 query-string parser 정상/비정상/긴입력 3회귀, lint/typecheck PASS. Android Hermes·web export PASS, 두 main sourcemap 모두 구 decode-uri-component 0개와 새 별칭+어댑터를 확인했다. 단독 decoder의 plus 계약은 query-string에서 사전 처리되므로 어댑터가 다시 변환하지 않는다. 잘못된 %25C2%FF는 새 단일 decoding 결과 %C2%FF를 유지한다.

미완료: Metro 번들 실행 회귀·수정 후 APK 재빌드/metadata 확인. 기존 APK는 패치 전이다. npm audit는 구 CLI 의존성이 남아 있으므로 전체 해소가 아니다. 커밋·푸시·배포 없음.

WBS: 사용자 요청으로 종현 관련 민규 공급물 의존18개 업무 항목 현황을 민규 필요로 변경했다. 상태값에 연결된 기존 수식은 새 값을0%로 표시한다. 수식 의미/진행률 임의 선택 없이 사용자 확인 항목으로 남긴다.

## 최종 아티팩트 검증

실제 Metro web bundle의 컴파일된 모듈19벡터 Node VM 실행 PASS(앱 bootstrap 제외). APK 재빌드1분41초/571tasks 성공. 44,653,809bytes, SHA256 b58d89d10b27db608a562f2cac258bcad4bab12acabc9e2a1935afcecd74f948. 최종 manifest/검증용서명 PASS, source hashes 불변. APK packager와 최종 결합 sourcemap 모두 수정판·어댑터 존재/구 decoder 없음. compiler.map은 원본 JS 소스 목록을 갖지 않는 중간 매핑이므로 별도 구분했다. 첫 확인 스크립트는 이를 원본 source map으로 간주해 실패했으며 실제 두 source map을 확인해 보완했다.

설치·전체앱 실행·native 인증은 미검증. 도구chain 취약점 잔여. WBS7.7/7.3a 본문에 새 결과1회씩 기록하고 읽기 확인. 이전 APK 결과는 과거 아티팩트로 보존한다.
