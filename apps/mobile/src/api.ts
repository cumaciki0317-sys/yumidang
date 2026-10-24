export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  constructor(status: number, code: string, retryable = false) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}
export type AuthenticationMode = "required" | "optional" | "anonymous";
// Hermes와 브라우저 모두에서 기본 aborted/EventTarget 기능만 사용한다.
export function checkAbort(signal: AbortSignal) {
  if (!signal.aborted) return;
  const error = new Error("Request aborted");
  error.name = "AbortError";
  throw error;
}
export function requestSignal(parents: readonly (AbortSignal | undefined)[], timeoutMs = 15000) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, timeoutMs);
  const activeParents = parents.filter((signal): signal is AbortSignal => !!signal);
  for (const parent of activeParents) {
    if (parent.aborted) abort();
    else parent.addEventListener("abort", abort);
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      for (const parent of activeParents) parent.removeEventListener("abort", abort);
    },
  };
}
export class ServiceApiClient {
  private readonly baseUrl: string;
  private readonly accessToken: () => Promise<string | null>;
  private readonly fetcher: typeof fetch;
  private readonly sessionIdentity?: () => unknown;
  private bindingIdentity: unknown;
  private bindingKey: object = {};
  /** Opaque in-memory identity; checked again before every step of a multi-request write. */
  async bindSession(): Promise<{ client: ServiceApiClient; key: object }> {
    const initialIdentity = this.sessionIdentity?.();
    const token = await this.accessToken();
    if (this.sessionIdentity && this.sessionIdentity() !== initialIdentity) throw new ApiError(401, "AUTH_REQUIRED");
    if (!token) { this.bindingIdentity = undefined; this.bindingKey = {}; throw new ApiError(401, "AUTH_REQUIRED"); }
    // A trusted session epoch survives token refresh and changes on logout/account switch.
    // Without that integration, conservatively bind to the exact token.
    const identity = this.sessionIdentity ? this.sessionIdentity() : token;
    if (this.bindingIdentity !== identity) { this.bindingIdentity = identity; this.bindingKey = {}; }
    const key = this.bindingKey;
    return { key, client: new ServiceApiClient(this.baseUrl, async () => {
      const current = await this.accessToken();
      const currentIdentity = this.sessionIdentity ? this.sessionIdentity() : current;
      if (!current || currentIdentity !== identity || key !== this.bindingKey) throw new ApiError(401, "AUTH_REQUIRED");
      return current;
    }, this.fetcher) };
  }
  constructor(
    baseUrl: string,
    accessToken: () => Promise<string | null>,
    fetcher: typeof fetch = fetch,
    sessionIdentity?: () => unknown,
  ) {
    const url = new URL(baseUrl);
    if (
      url.protocol !== "https:" || url.username || url.password || url.search ||
      url.hash
    ) {
      throw new Error("HTTPS service URL is required");
    }
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.accessToken = accessToken;
    this.fetcher = fetcher.bind(globalThis);
    this.sessionIdentity = sessionIdentity;
  }
  async request<T>(path: string, options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    auth?: AuthenticationMode;
    authenticated?: boolean;
    signal?: AbortSignal;
    inspection?: { operationId: string; ticketId: string };
  } = {}): Promise<T> {
    if (options.inspection) {
      const valid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (options.method !== "POST" || !valid.test(options.inspection.operationId) || !valid.test(options.inspection.ticketId) ||
        !/^\/posts(?:\/[0-9a-f-]+\/update)?$/i.test(path)) throw new ApiError(400, "INVALID_REQUEST");
    }
    const pathname = path.split("?")[0];
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      throw new ApiError(400, "INVALID_API_PATH");
    }
    if (
      !decoded.startsWith("/") || decoded.startsWith("//") ||
      /[\\#\r\n]/.test(path) ||
      decoded.split("/").some((segment) =>
        segment === "." || segment === ".."
      ) || decoded.includes("//")
    ) {
      throw new ApiError(400, "INVALID_API_PATH");
    }
    const auth = options.auth ??
      (options.authenticated === false ? "anonymous" : "required");
    const token = auth === "anonymous" ? null : await this.accessToken();
    if (auth === "required" && !token) throw new ApiError(401, "AUTH_REQUIRED");
    if (token && /[\r\n]/.test(token)) throw new ApiError(401, "AUTH_REQUIRED");
    const body = options.body === undefined
      ? undefined
      : JSON.stringify(options.body);
    if (
      body !== undefined &&
      new TextEncoder().encode(body).byteLength > 64 * 1024
    ) {
      throw new ApiError(413, "REQUEST_TOO_LARGE");
    }
    const request = requestSignal([options.signal]);
    try {
      checkAbort(request.signal);
      const response = await this.fetcher(this.baseUrl + path, {
        method: options.method || "GET",
        headers: {
          "Content-Type": "application/json",
          ...(options.inspection ? { "x-content-operation-id": options.inspection.operationId, "x-content-inspection-ticket": options.inspection.ticketId } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body,
        signal: request.signal,
        redirect: "error",
        cache: "no-store",
      });
      const envelope = await response.json();
      checkAbort(request.signal);
      if (
        !envelope || typeof envelope !== "object" || Array.isArray(envelope)
      ) {
        throw new ApiError(502, "INVALID_SERVICE_RESPONSE");
      }
      if (!response.ok || envelope.error) {
        throw new ApiError(
          response.status,
          typeof envelope.error?.code === "string"
            ? envelope.error.code
            : "REQUEST_FAILED",
          envelope.error?.retryable === true,
        );
      }
      if (!Object.prototype.hasOwnProperty.call(envelope, "data")) {
        throw new ApiError(502, "INVALID_SERVICE_RESPONSE");
      }
      return envelope.data as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (request.signal.aborted) {
        throw new ApiError(
          408,
          options.signal?.aborted ? "CANCELLED" : "REQUEST_TIMEOUT",
          !options.signal?.aborted,
        );
      }
      throw new ApiError(503, "SERVICE_UNAVAILABLE", true);
    } finally {
      request.dispose();
    }
  }
}
