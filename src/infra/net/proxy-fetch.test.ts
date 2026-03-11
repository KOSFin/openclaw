import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ProxyAgent, EnvHttpProxyAgent, undiciFetch, proxyAgentSpy, envAgentSpy, getLastAgent } =
  vi.hoisted(() => {
    const undiciFetch = vi.fn();
    const proxyAgentSpy = vi.fn();
    const envAgentSpy = vi.fn();
    class ProxyAgent {
      static lastCreated: ProxyAgent | undefined;
      proxyUrl: string;
      constructor(proxyUrl: string) {
        this.proxyUrl = proxyUrl;
        ProxyAgent.lastCreated = this;
        proxyAgentSpy(proxyUrl);
      }
    }
    class EnvHttpProxyAgent {
      static lastCreated: EnvHttpProxyAgent | undefined;
      constructor() {
        EnvHttpProxyAgent.lastCreated = this;
        envAgentSpy();
      }
    }

    return {
      ProxyAgent,
      EnvHttpProxyAgent,
      undiciFetch,
      proxyAgentSpy,
      envAgentSpy,
      getLastAgent: () => ProxyAgent.lastCreated,
    };
  });

vi.mock("undici", () => ({
  ProxyAgent,
  EnvHttpProxyAgent,
  fetch: undiciFetch,
}));

import {
  makeProxyFetch,
  resolveModelsOauthProxyFetchFromEnv,
  withScopedModelsOauthProxyEnv,
  resolveProxyFetchFromEnv,
} from "./proxy-fetch.js";

describe("makeProxyFetch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses undici fetch with ProxyAgent dispatcher", async () => {
    const proxyUrl = "http://proxy.test:8080";
    undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch(proxyUrl);
    expect(proxyAgentSpy).not.toHaveBeenCalled();
    await proxyFetch("https://api.example.com/v1/audio");

    expect(proxyAgentSpy).toHaveBeenCalledWith(proxyUrl);
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/audio",
      expect.objectContaining({ dispatcher: getLastAgent() }),
    );
  });
});

describe("resolveProxyFetchFromEnv", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it("returns undefined when no proxy env vars are set", () => {
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("http_proxy", "");

    expect(resolveProxyFetchFromEnv()).toBeUndefined();
  });

  it("returns proxy fetch using EnvHttpProxyAgent when HTTPS_PROXY is set", async () => {
    // Stub empty vars first — on Windows, process.env is case-insensitive so
    // HTTPS_PROXY and https_proxy share the same slot. Value must be set LAST.
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("http_proxy", "");
    vi.stubEnv("HTTPS_PROXY", "http://proxy.test:8080");
    undiciFetch.mockResolvedValue({ ok: true });

    const fetchFn = resolveProxyFetchFromEnv();
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();

    await fetchFn!("https://api.example.com");
    expect(undiciFetch).toHaveBeenCalledWith(
      "https://api.example.com",
      expect.objectContaining({ dispatcher: EnvHttpProxyAgent.lastCreated }),
    );
  });

  it("returns proxy fetch when HTTP_PROXY is set", () => {
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("http_proxy", "");
    vi.stubEnv("HTTP_PROXY", "http://fallback.test:3128");

    const fetchFn = resolveProxyFetchFromEnv();
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();
  });

  it("returns proxy fetch when lowercase https_proxy is set", () => {
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("http_proxy", "");
    vi.stubEnv("https_proxy", "http://lower.test:1080");

    const fetchFn = resolveProxyFetchFromEnv();
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();
  });

  it("returns proxy fetch when lowercase http_proxy is set", () => {
    vi.stubEnv("HTTPS_PROXY", "");
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("http_proxy", "http://lower-http.test:1080");

    const fetchFn = resolveProxyFetchFromEnv();
    expect(fetchFn).toBeDefined();
    expect(envAgentSpy).toHaveBeenCalled();
  });

  it("returns undefined when EnvHttpProxyAgent constructor throws", () => {
    vi.stubEnv("HTTP_PROXY", "");
    vi.stubEnv("https_proxy", "");
    vi.stubEnv("http_proxy", "");
    vi.stubEnv("HTTPS_PROXY", "not-a-valid-url");
    envAgentSpy.mockImplementationOnce(() => {
      throw new Error("Invalid URL");
    });

    const fetchFn = resolveProxyFetchFromEnv();
    expect(fetchFn).toBeUndefined();
  });
});

describe("resolveModelsOauthProxyFetchFromEnv", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllEnvs());

  it("returns undefined when dedicated proxy env vars are unset", () => {
    vi.stubEnv("OPENCLAW_MODELS_OAUTH_PROXY", "");
    vi.stubEnv("OPENCLAW_MODEL_OAUTH_PROXY", "");

    expect(resolveModelsOauthProxyFetchFromEnv()).toBeUndefined();
  });

  it("uses OPENCLAW_MODELS_OAUTH_PROXY when set", async () => {
    vi.stubEnv("OPENCLAW_MODELS_OAUTH_PROXY", "socks5://proxy.test:1080");
    undiciFetch.mockResolvedValue({ ok: true });

    const fetchFn = resolveModelsOauthProxyFetchFromEnv();
    expect(fetchFn).toBeDefined();

    await fetchFn!("https://api.example.com");
    expect(proxyAgentSpy).toHaveBeenCalledWith("socks5://proxy.test:1080");
  });

  it("falls back to OPENCLAW_MODEL_OAUTH_PROXY alias", async () => {
    vi.stubEnv("OPENCLAW_MODELS_OAUTH_PROXY", "");
    vi.stubEnv("OPENCLAW_MODEL_OAUTH_PROXY", "http://proxy.test:8080");
    undiciFetch.mockResolvedValue({ ok: true });

    const fetchFn = resolveModelsOauthProxyFetchFromEnv();
    expect(fetchFn).toBeDefined();

    await fetchFn!("https://api.example.com");
    expect(proxyAgentSpy).toHaveBeenCalledWith("http://proxy.test:8080");
  });
});

describe("withScopedModelsOauthProxyEnv", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("does not modify env when dedicated proxy is unset", async () => {
    vi.stubEnv("OPENCLAW_MODELS_OAUTH_PROXY", "");
    const original = process.env.HTTPS_PROXY;

    await withScopedModelsOauthProxyEnv(async () => {
      expect(process.env.HTTPS_PROXY).toBe(original);
    });
  });

  it("applies proxy only inside scope and restores previous env", async () => {
    vi.stubEnv("OPENCLAW_MODELS_OAUTH_PROXY", "socks5://proxy.test:1080");
    const previousHttps = process.env.HTTPS_PROXY;

    await withScopedModelsOauthProxyEnv(async () => {
      expect(process.env.HTTPS_PROXY).toBe("socks5://proxy.test:1080");
      expect(process.env.HTTP_PROXY).toBe("socks5://proxy.test:1080");
      expect(process.env.ALL_PROXY).toBe("socks5://proxy.test:1080");
    });

    expect(process.env.HTTPS_PROXY).toBe(previousHttps);
  });
});
