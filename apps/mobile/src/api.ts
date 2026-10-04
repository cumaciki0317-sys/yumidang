export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}
/** Existing service-api transport. Kept separate from the local prototype adapter. */
export class ServiceApiClient {
  constructor(
    private baseUrl: string,
    private accessToken: () => Promise<string | null>,
  ) {
    if (!/^https:\/\//.test(baseUrl))
      throw new Error("HTTPS service URL is required");
  }
  async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PATCH" | "DELETE";
      body?: unknown;
      authenticated?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes(".."))
      throw new Error("Invalid API path");
    const token =
      options.authenticated === false ? null : await this.accessToken();
    if (options.authenticated !== false && !token)
      throw new ApiError(401, "AUTH_REQUIRED");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const abort = () => controller.abort();
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort);
    try {
      const response = await fetch(this.baseUrl.replace(/\/$/, "") + path, {
        method: options.method || "GET",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        redirect: "error",
      });
      const envelope = await response.json();
      if (!response.ok || envelope.error)
        throw new ApiError(
          response.status,
          envelope.error?.code || "REQUEST_FAILED",
        );
      return envelope.data as T;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }
}
