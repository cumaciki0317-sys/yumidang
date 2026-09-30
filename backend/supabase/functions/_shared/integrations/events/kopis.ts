/**
 * 종현담당. KOPIS 공연목록(pblprfr) transport·정규화.
 * 공식 가이드 v5.0: 요청 service/stdate/eddate(최대 31일)/cpage/rows(최대 100), XML <dbs><db>..</db></dbs> 응답.
 * 가이드의 운영 주소는 http://www.kopis.or.kr 이지만 키를 HTTP로 보내지 않는다. 2026-09-29 키 없는 확인에서
 * https://kopis.or.kr(인증서 SAN kopis.or.kr/www.kopis.or.kr)가 같은 API의 XML 오류 envelope를 반환했다.
 * www는 apex로 301 redirect 하므로 apex를 고정하고 redirect를 따르지 않는다.
 * 목록 API에는 가격·주소·명시적 취소 상태·공식 상세 페이지 주소가 없다. 입장료는 unknown, 주소·sourceUrl은 null이다.
 */
import { createEventProviderAdapter, type EventProviderTransport } from "./adapter.ts";
import { parseCalendarDate } from "./normalize.ts";
import { EventProviderError } from "./port.ts";
import type { EventFetchRequest, EventProviderPort, SourceEventRecord } from "./port.ts";

export const KOPIS_PROVIDER = "kopis";
const endpoint = "https://kopis.or.kr/openApi/restful/pblprfr";
/** 공식 가이드의 요청 제한. 운영 수집량이 아니라 공급사 규격 상한이다. */
export const KOPIS_MAX_PERIOD_DAYS = 31;
export const KOPIS_MAX_ROWS = 100;
/** cpage 항목 크기 3자리. */
export const KOPIS_MAX_PAGE = 999;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export interface KopisConfig {
  apiKey: string;
  /** 공통 설정의 명시 값(밀리초). */
  timeoutMs: number;
  /** 한 페이지 목록 수. 명시 환경값이며 1..100. */
  rows: number;
  fetch: FetchLike;
}

/** 공식 목록 응답의 항목. 문서에 없는 요소가 오면 응답 전체를 거절한다. */
export interface KopisListItem {
  mt20id: string;
  prfnm: string;
  prfpdfrom: string;
  prfpdto: string;
  prfstate: string;
  fcltynm?: string;
  area?: string;
  genrenm?: string;
  poster?: string;
  openrun?: string;
}
const requiredFields = ["mt20id", "prfnm", "prfpdfrom", "prfpdto", "prfstate"] as const;
const itemFields = new Set<string>([...requiredFields, "fcltynm", "area", "genrenm", "poster", "openrun"]);
const errorFields = new Set(["returncode", "errmsg", "responsetime"]);

const invalid = (): never => { throw new EventProviderError("SOURCE_INVALID_RESPONSE"); };

/* ---------- 평면 XML 파서 ---------- */

const namePattern = /[A-Za-z_][A-Za-z0-9_]*/y;
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

/**
 * `<?xml ...?>` 선언(선택) + `<dbs>` 루트 + `<db>` 반복 + 각 db 안의 속성 없는 단일 수준 요소만 허용한다.
 * DOCTYPE·주석·처리 명령·속성·중첩 요소·중복 요소·알 수 없는 entity·제어문자는 모두 거절한다.
 * 반환값은 요소 이름 → 복호화·앞뒤 공백 제거한 텍스트다.
 */
export function parseFlatDbsXml(xml: string): Record<string, string>[] {
  if (typeof xml !== "string") return invalid();
  let i = 0;
  const n = xml.length;
  const ws = () => { while (i < n && (xml[i] === " " || xml[i] === "\t" || xml[i] === "\r" || xml[i] === "\n")) i++; };
  const expect = (literal: string) => { if (!xml.startsWith(literal, i)) invalid(); i += literal.length; };
  const name = (): string => {
    namePattern.lastIndex = i;
    const match = namePattern.exec(xml);
    if (!match) return invalid();
    i += match[0].length;
    return match[0];
  };
  /** 여는 태그를 읽고 self-closing 여부를 반환한다. 속성은 허용하지 않는다. */
  const openTag = (): { tag: string; empty: boolean } => {
    expect("<");
    const tag = name();
    ws();
    if (xml.startsWith("/>", i)) { i += 2; return { tag, empty: true }; }
    expect(">");
    return { tag, empty: false };
  };
  const closeTag = (tag: string) => { expect("</"); if (name() !== tag) invalid(); ws(); expect(">"); };
  const text = (): string => {
    let out = "";
    while (i < n) {
      const ch = xml[i];
      if (xml.startsWith("<![CDATA[", i)) {
        const end = xml.indexOf("]]>", i + 9);
        if (end < 0) invalid();
        out += xml.slice(i + 9, end);
        i = end + 3;
        continue;
      }
      if (ch === "<") break;
      if (ch === "&") {
        const end = xml.indexOf(";", i);
        if (end < 0 || end - i > 10) invalid();
        const ref = xml.slice(i + 1, end);
        let decoded: string;
        if (/^#[0-9]{1,7}$/.test(ref)) decoded = codePoint(Number(ref.slice(1)));
        else if (/^#x[0-9A-Fa-f]{1,6}$/.test(ref)) decoded = codePoint(parseInt(ref.slice(2), 16));
        else if (Object.hasOwn(entities, ref)) decoded = entities[ref];
        else return invalid();
        out += decoded;
        i = end + 1;
        continue;
      }
      if (ch === ">" && xml.startsWith("]]>", i - 2)) invalid();
      out += ch;
      i++;
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/u.test(out)) invalid();
    return out;
  };

  if (xml.startsWith("<?xml", i)) {
    const end = xml.indexOf("?>", i);
    if (end < 0) invalid();
    const declaration = xml.slice(i, end + 2);
    if (!/^<\?xml version="1\.0"(?: encoding="UTF-8")?(?: standalone="(?:yes|no)")?\s*\?>$/i.test(declaration)) invalid();
    i = end + 2;
  }
  ws();
  const root = openTag();
  if (root.tag !== "dbs") invalid();
  const records: Record<string, string>[] = [];
  if (!root.empty) {
    while (true) {
      ws();
      if (xml.startsWith("</", i)) break;
      const db = openTag();
      if (db.tag !== "db" || db.empty) invalid();
      const record: Record<string, string> = Object.create(null);
      while (true) {
        ws();
        if (xml.startsWith("</", i)) break;
        const field = openTag();
        if (field.tag === "db" || field.tag === "dbs" || Object.hasOwn(record, field.tag)) invalid();
        if (field.empty) { record[field.tag] = ""; continue; }
        const value = text();
        closeTag(field.tag);
        record[field.tag] = value.trim();
      }
      closeTag("db");
      if (!Object.keys(record).length) invalid();
      records.push(record);
    }
    closeTag("dbs");
  }
  ws();
  if (i !== n) invalid();
  return records;
}

function codePoint(value: number): string {
  if (!Number.isInteger(value) || value < 1 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return invalid();
  return String.fromCodePoint(value);
}

/* ---------- 응답 분류 ---------- */

/**
 * 공급사 오류 envelope(db 안의 returncode)는 HTTP 200이어도 실패다. 오류 메시지 원문은 버린다.
 * 확인된 코드: 02 = 등록되지 않은 서비스 키(2026-09-29 키 없는 요청에서 관찰). 코드표 전체는 미확인이다.
 */
export function classifyKopisListResponse(records: readonly Record<string, string>[], rows: number): KopisListItem[] {
  if (records.some((record) => Object.hasOwn(record, "returncode"))) {
    if (records.length !== 1 || Object.keys(records[0]).some((key) => !errorFields.has(key))) invalid();
    const code = records[0].returncode;
    if (!/^[0-9]{2}$/.test(code)) invalid();
    throw new EventProviderError(code === "02" ? "SOURCE_AUTH_REJECTED" : "SOURCE_REJECTED");
  }
  if (records.length > rows) invalid();
  const seen = new Set<string>();
  return records.map((record) => {
    const keys = Object.keys(record);
    if (keys.some((key) => !itemFields.has(key)) || requiredFields.some((key) => !Object.hasOwn(record, key))) invalid();
    const item = record as unknown as KopisListItem;
    if (!/^PF[0-9]{1,30}$/.test(item.mt20id) || seen.has(item.mt20id)) invalid();
    seen.add(item.mt20id);
    return item;
  });
}

/* ---------- 정규화 ---------- */

function kopisDate(value: string): string {
  const match = /^([0-9]{4})\.([0-9]{2})\.([0-9]{2})$/.exec(value);
  if (!match) throw new Error("INVALID_EVENT_DATE");
  const iso = `${match[1]}-${match[2]}-${match[3]}`;
  parseCalendarDate(iso);
  return iso;
}
function optionalText(value: string | undefined): string | null {
  return value === undefined || value.trim() === "" ? null : value.trim().replace(/\s+/gu, " ");
}
/** 공연예정·공연중·공연완료는 날짜 상태일 뿐 취소가 아니다. 목록 API에 명시 취소 값은 문서화되어 있지 않다. */
const activeStates = new Set(["공연예정", "공연중", "공연완료"]);

export function normalizeKopisListItem(raw: KopisListItem, context: { provider: string; collectedAt: string }): SourceEventRecord {
  if (!activeStates.has(raw.prfstate)) throw new Error("UNSUPPORTED_EVENT_SOURCE_STATUS");
  const startsOn = kopisDate(raw.prfpdfrom);
  const endsOn = kopisDate(raw.prfpdto);
  const title = optionalText(raw.prfnm);
  if (title === null) throw new Error("INVALID_EVENT_SOURCE_RECORD");
  return {
    provider: context.provider,
    sourceId: raw.mt20id,
    sourceStatus: "active",
    precision: "date",
    startsOn,
    endsOn,
    title,
    // 제공처 값을 그대로 쓴다. 다른 제공처 값과 매핑·병합하지 않는다.
    category: optionalText(raw.genrenm),
    region: optionalText(raw.area),
    placeName: optionalText(raw.fcltynm),
    publicAddress: null,
    admission: { kind: "unknown" },
    sourceUrl: null,
    collectedAt: context.collectedAt,
  };
}

/* ---------- transport ---------- */

function compactDate(value: string): string {
  parseCalendarDate(value);
  return value.replaceAll("-", "");
}
export function inclusiveDays(start: string, end: string): number {
  const days = (parseCalendarDate(end).getTime() - parseCalendarDate(start).getTime()) / 86_400_000 + 1;
  if (!Number.isInteger(days) || days < 1) throw new EventProviderError("INVALID_EVENT_REQUEST");
  return days;
}

function validateConfig(config: KopisConfig): void {
  if (!config || typeof config.apiKey !== "string" || !config.apiKey || /[\s\u0000-\u001f\u007f]/u.test(config.apiKey)) {
    throw new EventProviderError("EVENT_PROVIDER_UNCONFIGURED");
  }
  if (typeof config.fetch !== "function" || !Number.isInteger(config.rows) || config.rows < 1 || config.rows > KOPIS_MAX_ROWS ||
      !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2_147_483_647) {
    throw new EventProviderError("EVENT_PROVIDER_UNCONFIGURED");
  }
}

export function createKopisTransport(config: KopisConfig): EventProviderTransport<KopisListItem> {
  validateConfig(config);
  const { apiKey, timeoutMs, rows, fetch: transport } = config;
  return {
    async fetchPage(request: EventFetchRequest) {
      if (!request || request.cursor !== undefined || !request.period ||
          !Number.isInteger(request.page) || request.page! < 1 || request.page! > KOPIS_MAX_PAGE) {
        throw new EventProviderError("INVALID_EVENT_REQUEST");
      }
      const page = request.page!;
      let stdate: string, eddate: string;
      try {
        if (inclusiveDays(request.period.start, request.period.end) > KOPIS_MAX_PERIOD_DAYS) {
          throw new EventProviderError("INVALID_EVENT_REQUEST");
        }
        stdate = compactDate(request.period.start);
        eddate = compactDate(request.period.end);
      } catch {
        throw new EventProviderError("INVALID_EVENT_REQUEST");
      }
      const url = new URL(endpoint);
      url.searchParams.set("service", apiKey);
      url.searchParams.set("stdate", stdate);
      url.searchParams.set("eddate", eddate);
      url.searchParams.set("cpage", String(page));
      url.searchParams.set("rows", String(rows));

      const controller = new AbortController();
      let timedOut = false;
      const cancel = () => controller.abort();
      request.signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new EventProviderError(timedOut ? "SOURCE_TIMEOUT" : "CANCELLED"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      // 호출 전 취소처럼 race에 들어가지 않은 경우에도 처리되지 않은 거부가 남지 않게 한다.
      aborted.catch(() => {});
      try {
        if (request.signal?.aborted) controller.abort();
        if (controller.signal.aborted) throw new EventProviderError("CANCELLED");
        const work = (async () => {
          const response = await transport(url.toString(), {
            method: "GET",
            headers: { Accept: "application/xml" },
            signal: controller.signal,
            redirect: "error",
            credentials: "omit",
            cache: "no-store",
          });
          if (response.status === 401 || response.status === 403) throw new EventProviderError("SOURCE_AUTH_REJECTED");
          if (response.status === 429) throw new EventProviderError("SOURCE_RATE_LIMITED");
          if (response.status >= 500) throw new EventProviderError("SOURCE_UNAVAILABLE");
          if (response.status !== 200) throw new EventProviderError("SOURCE_REJECTED");
          if (!/^(application|text)\/xml(\s*;.*)?$/i.test(response.headers.get("content-type") ?? "")) invalid();
          let body: string;
          try { body = await response.text(); } catch { return invalid(); }
          const items = classifyKopisListResponse(parseFlatDbsXml(body), rows);
          // 공급사가 전체 건수를 주지 않는다. 꽉 찬 페이지만 다음 페이지 가능성이 있다.
          const hasMore = items.length === rows && page < KOPIS_MAX_PAGE;
          return { items, ...(hasMore ? { nextCursor: String(page + 1) } : {}) };
        })();
        return await Promise.race([work, aborted]);
      } catch (error) {
        if (controller.signal.aborted) throw new EventProviderError(timedOut ? "SOURCE_TIMEOUT" : "CANCELLED");
        if (error instanceof EventProviderError) throw error;
        throw new EventProviderError("SOURCE_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", cancel);
        controller.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** KOPIS transport + 정규화 + 기존 공통 어댑터 검사(제공처·수집 시각 일치). */
export function createKopisEventProvider(config: KopisConfig & { now: () => Date }): EventProviderPort {
  return createEventProviderAdapter({
    provider: KOPIS_PROVIDER,
    transport: createKopisTransport(config),
    normalize: normalizeKopisListItem,
    now: config.now,
  });
}
