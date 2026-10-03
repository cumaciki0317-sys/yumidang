/** 민규담당. 서버가 네이버에서 직접 확인한 최소 회원 정보. 외부 토큰은 반환하지 않는다. */
export interface NaverProfile {
  subject: string;
  name: string | null;
  gender: "F" | "M" | "U" | null;
  /** 유효한 달력 날짜 YYYY-MM-DD. 가입 자격·한국 기준 만 나이는 DB가 판정한다. */
  birthDate: string | null;
}
export interface NaverIdentityPort {
  authorizationUrl(state: string): string;
  /** state의 브라우저 귀속·만료·단일 사용 검사는 호출 서비스가 먼저 수행한다. */
  exchange(code: string, state: string): Promise<NaverProfile>;
}
