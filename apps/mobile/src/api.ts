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
export class ServiceApiClient {
  private readonly baseUrl: string;
  private readonly accessToken: () => Promise<string | null>;
  private readonly fetcher: typeof fetch;
  constructor(
    baseUrl: string,
    accessToken: () => Promise<string | null>,
    fetcher: typeof fetch = fetch,
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
  }
  async request<T>(path: string, options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
    auth?: AuthenticationMode;
    authenticated?: boolean;
    signal?: AbortSignal;
  } = {}): Promise<T> {
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
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, 15000);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort);
    try {
      controller.signal.throwIfAborted();
      const response = await this.fetcher(this.baseUrl + path, {
        method: options.method || "GET",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body,
        signal: controller.signal,
        redirect: "error",
        cache: "no-store",
      });
      const envelope = await response.json();
      controller.signal.throwIfAborted();
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
      if (controller.signal.aborted) {
        throw new ApiError(
          408,
          options.signal?.aborted ? "CANCELLED" : "REQUEST_TIMEOUT",
          !options.signal?.aborted,
        );
      }
      throw new ApiError(503, "SERVICE_UNAVAILABLE", true);
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
