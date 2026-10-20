> 사용자 해석 정정: “호출 계속”은 즉시 추가 조회를 지시한 뜻이 아니라, 집계 기간 대조 중에도 일반 개발·다른 API·칼럼 정리를 병행하라는 뜻이다. 아래 표본 호출은 당시 실행 기록으로 보존하며 주기 호출 설치를 뜻하지 않는다.

# KOPIS 기본 조회 계속 진행 — 실제 호출 결과

당시 에이전트 해석으로 기본 표본 호출을 실행했다. 이후 사용자는 일반 개발·데이터 정리를 병행하라는 뜻으로 정정했다. 자동 운영 수집 설치·DB 변경 승인을 뜻하지 않는다.

# KOPIS 기본 목록·상세·시설 실제 조회

API 조회 UTC: 2026-10-19T09:56:40.230802~09:56:40.579892 / KST 18:56:40.

- API 성공 4회: 목록 2페이지 각 2개, 공연 상세 1개, 시설 상세 1개. 모두 HTTP200/TLS검증0. 샌드박스 DNS 실패 2회는 실제 API 도달이 아님.
- 31일 구간 2026-10-19~11-18. 총4개 고유 ID, 페이지 중복0. 전체 수/정렬의 공식 보장은 확인하지 않음.
- PF303837 → FC002634 → FC002634-01 연결 일치. 주소·좌표, 가격 안내, 관람연령, 출연진, 프로그램설명, 요일시간, 관련링크 수신.
- prfcrew/prfruntime/일부사업자명은 공백: 결측으로 취급할 필요. 없는 값을 생성하거나 미정과 없음 혼동 금지.
- 관련링크는 더하우스콘서트 HTTPS주소이며 실제 사이트 접속/예매가능 여부 검증은 아님.
- 포스터·소개이미지 원천 URL은 HTTP. 표본 각1개에 대해 HTTPS www는301, 명시된 canonical https://kopis.or.kr 동일경로는200 image/png TLS검증0. 자동redirect금지, HEAD만4회. 이미지별 일반화/실제화면렌더 미검증.
- 시설 N/0/공백을 실시간 이용가능·예약가능·확정 미제공으로 확대해석하지 않음.
- 순위 집계기간 문제와 별개로 일반조회 계속 가능. 코드·DB·정기수집·운영반영·배포 없음.

## 원본 SHA-256

- list-page-1: `422d2654c5347a72f49d81c7c269e32a440e6866c4a9e837aaa814a739e3ae5a`
- list-page-2: `bedb71e2fbced9f755dd75a00c7f2b75dd7e5e93e50143ab1a448088a65b7f68`
- performance-detail: `4f4b6a9e2240169d9be39b643cf2e237473f5c5d9da40fcfd5bb2f3edb534d88`
- facility-detail: `13aae75f86a7340c93a9a5a9a675a4126bbd08856cb1b6eee8d253305313c9ce`
- poster-https-head.txt: `fe2daa47e0744ff6586c83e103e55414b2ee783895d1c1435876b26e732f0932`
- intro-image-https-head.txt: `fd69edbccee37a97c611cba4dcb0914ce3ecd443fac42667915cdd0c3d69d8b0`
- poster-canonical-https-head.txt: `4e366976fe99f9cd079d8e8d9689acd10b7957e01dfc55bf2251c33a9bd56947`
- intro-image-canonical-https-head.txt: `b541c9dc3e48b198f6083105da1b86edf30e51d5f9d7853cc2751ecb54ee6e03`


[통합용 안전 요약·해시](2026-10-19-kopis-basic-evidence.json)
