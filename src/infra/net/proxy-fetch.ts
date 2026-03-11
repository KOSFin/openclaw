import { EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { logWarn } from "../../logger.js";

const MODELS_OAUTH_PROXY_ENV_KEYS = ["OPENCLAW_MODELS_OAUTH_PROXY", "OPENCLAW_MODEL_OAUTH_PROXY"];
const MODELS_OAUTH_SCOPED_PROXY_TARGET_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
] as const;

export const PROXY_FETCH_PROXY_URL = Symbol.for("openclaw.proxyFetch.proxyUrl");
type ProxyFetchWithMetadata = typeof fetch & {
  [PROXY_FETCH_PROXY_URL]?: string;
};

/**
 * Create a fetch function that routes requests through the given HTTP proxy.
 * Uses undici's ProxyAgent under the hood.
 */
export function makeProxyFetch(proxyUrl: string): typeof fetch {
  let agent: ProxyAgent | null = null;
  const resolveAgent = (): ProxyAgent => {
    if (!agent) {
      agent = new ProxyAgent(proxyUrl);
    }
    return agent;
  };
  // undici's fetch is runtime-compatible with global fetch but the types diverge
  // on stream/body internals. Single cast at the boundary keeps the rest type-safe.
  const proxyFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: resolveAgent(),
    }) as unknown as Promise<Response>) as ProxyFetchWithMetadata;
  Object.defineProperty(proxyFetch, PROXY_FETCH_PROXY_URL, {
    value: proxyUrl,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return proxyFetch;
}

export function getProxyUrlFromFetch(fetchImpl?: typeof fetch): string | undefined {
  const proxyUrl = (fetchImpl as ProxyFetchWithMetadata | undefined)?.[PROXY_FETCH_PROXY_URL];
  if (typeof proxyUrl !== "string") {
    return undefined;
  }
  const trimmed = proxyUrl.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve a proxy-aware fetch from standard environment variables
 * (HTTPS_PROXY, HTTP_PROXY, https_proxy, http_proxy).
 * Respects NO_PROXY / no_proxy exclusions via undici's EnvHttpProxyAgent.
 * Returns undefined when no proxy is configured.
 * Gracefully returns undefined if the proxy URL is malformed.
 */
export function resolveProxyFetchFromEnv(): typeof fetch | undefined {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy;
  if (!proxyUrl?.trim()) {
    return undefined;
  }
  try {
    const agent = new EnvHttpProxyAgent();
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as string | URL, {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof fetch;
  } catch (err) {
    logWarn(
      `Proxy env var set but agent creation failed — falling back to direct fetch: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

export function resolveModelsOauthProxyUrlFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const key of MODELS_OAUTH_PROXY_ENV_KEYS) {
    const proxyUrl = env[key]?.trim();
    if (proxyUrl) {
      return proxyUrl;
    }
  }
  return undefined;
}

/**
 * Resolve a dedicated proxy fetch for model API + OAuth traffic only.
 * Uses explicit OpenClaw-scoped env vars and does not rely on NO_PROXY logic.
 */
export function resolveModelsOauthProxyFetchFromEnv(): typeof fetch | undefined {
  const proxyUrl = resolveModelsOauthProxyUrlFromEnv();
  if (!proxyUrl) {
    return undefined;
  }
  try {
    return makeProxyFetch(proxyUrl);
  } catch (err) {
    logWarn(
      `OPENCLAW_MODELS_OAUTH_PROXY is set but proxy fetch initialization failed — falling back to direct fetch: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

export async function withScopedModelsOauthProxyEnv<T>(fn: () => Promise<T>): Promise<T> {
  const proxyUrl = resolveModelsOauthProxyUrlFromEnv();
  if (!proxyUrl) {
    return await fn();
  }

  const previous: Partial<
    Record<(typeof MODELS_OAUTH_SCOPED_PROXY_TARGET_ENV_KEYS)[number], string | undefined>
  > = {};
  for (const key of MODELS_OAUTH_SCOPED_PROXY_TARGET_ENV_KEYS) {
    previous[key] = process.env[key];
    process.env[key] = proxyUrl;
  }

  // Also swap the undici global dispatcher so OpenAI/Google SDKs (which use global fetch → undici)
  // actually route through the proxy. Env-var mutation alone is insufficient because those SDKs
  // create HTTP clients once and never re-read proxy env vars per-request.
  const previousDispatcher = getGlobalDispatcher();
  let proxyAgent: ProxyAgent | null = null;
  try {
    proxyAgent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(proxyAgent);
  } catch (err) {
    logWarn(
      `OPENCLAW_MODELS_OAUTH_PROXY: failed to install global proxy dispatcher — LLM requests may bypass proxy: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    return await fn();
  } finally {
    for (const key of MODELS_OAUTH_SCOPED_PROXY_TARGET_ENV_KEYS) {
      const value = previous[key];
      if (typeof value === "string") {
        process.env[key] = value;
      } else {
        delete process.env[key];
      }
    }
    if (proxyAgent !== null) {
      try {
        setGlobalDispatcher(previousDispatcher);
      } catch {
        // Best-effort restore
      }
      proxyAgent.destroy().catch(() => {});
    }
  }
}
