import type {
  GatewayAuthConfig,
  GatewayBindMode,
  GatewayTailscaleConfig,
  loadConfig,
} from "../config/config.js";
import {
  assertGatewayAuthConfigured,
  type ResolvedGatewayAuth,
  resolveGatewayAuth,
} from "./auth.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { resolveHooksConfig } from "./hooks.js";
import {
  isLoopbackHost,
  isTrustedProxyAddress,
  isValidIPv4,
  resolveGatewayBindHost,
} from "./net.js";
import { mergeGatewayTailscaleConfig } from "./startup-auth.js";

const CONTROL_UI_ALLOWED_ORIGINS_ENV_KEYS = [
  "OPENCLAW_GATEWAY_CONTROLUI_ALLOWED_ORIGINS",
  "OPENCLAW_GATEWAY_CONTROL_UI_ALLOWED_ORIGINS",
] as const;

const CONTROL_UI_HOST_HEADER_FALLBACK_ENV_KEYS = [
  "OPENCLAW_GATEWAY_CONTROLUI_DANGEROUSLY_ALLOW_HOST_HEADER_ORIGIN_FALLBACK",
  "OPENCLAW_GATEWAY_CONTROL_UI_DANGEROUSLY_ALLOW_HOST_HEADER_ORIGIN_FALLBACK",
] as const;

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function resolveFirstNonEmptyEnv(keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const raw = process.env[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw.trim();
    }
  }
  return undefined;
}

function parseControlUiAllowedOriginsFromEnv(): string[] {
  const raw = resolveFirstNonEmptyEnv(CONTROL_UI_ALLOWED_ORIGINS_ENV_KEYS);
  if (!raw) {
    return [];
  }
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return [...new Set(parsed.map((value) => String(value).trim()).filter(Boolean))];
      }
    } catch {
      // Fall back to comma-separated parsing below.
    }
  }
  return [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
}

function resolveControlUiHostHeaderFallbackFromEnv(): boolean | undefined {
  for (const key of CONTROL_UI_HOST_HEADER_FALLBACK_ENV_KEYS) {
    const parsed = parseBooleanEnv(process.env[key]);
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

export type GatewayRuntimeConfig = {
  bindHost: string;
  controlUiEnabled: boolean;
  openAiChatCompletionsEnabled: boolean;
  openAiChatCompletionsConfig?: import("../config/types.gateway.js").GatewayHttpChatCompletionsConfig;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  strictTransportSecurityHeader?: string;
  controlUiBasePath: string;
  controlUiRoot?: string;
  resolvedAuth: ResolvedGatewayAuth;
  authMode: ResolvedGatewayAuth["mode"];
  tailscaleConfig: GatewayTailscaleConfig;
  tailscaleMode: "off" | "serve" | "funnel";
  hooksConfig: ReturnType<typeof resolveHooksConfig>;
  canvasHostEnabled: boolean;
};

export async function resolveGatewayRuntimeConfig(params: {
  cfg: ReturnType<typeof loadConfig>;
  port: number;
  bind?: GatewayBindMode;
  host?: string;
  controlUiEnabled?: boolean;
  openAiChatCompletionsEnabled?: boolean;
  openResponsesEnabled?: boolean;
  auth?: GatewayAuthConfig;
  tailscale?: GatewayTailscaleConfig;
}): Promise<GatewayRuntimeConfig> {
  const bindMode = params.bind ?? params.cfg.gateway?.bind ?? "loopback";
  const customBindHost = params.cfg.gateway?.customBindHost;
  const bindHost = params.host ?? (await resolveGatewayBindHost(bindMode, customBindHost));
  if (bindMode === "loopback" && !isLoopbackHost(bindHost)) {
    throw new Error(
      `gateway bind=loopback resolved to non-loopback host ${bindHost}; refusing fallback to a network bind`,
    );
  }
  if (bindMode === "custom") {
    const configuredCustomBindHost = customBindHost?.trim();
    if (!configuredCustomBindHost) {
      throw new Error("gateway.bind=custom requires gateway.customBindHost");
    }
    if (!isValidIPv4(configuredCustomBindHost)) {
      throw new Error(
        `gateway.bind=custom requires a valid IPv4 customBindHost (got ${configuredCustomBindHost})`,
      );
    }
    if (bindHost !== configuredCustomBindHost) {
      throw new Error(
        `gateway bind=custom requested ${configuredCustomBindHost} but resolved ${bindHost}; refusing fallback`,
      );
    }
  }
  const controlUiEnabled =
    params.controlUiEnabled ?? params.cfg.gateway?.controlUi?.enabled ?? true;
  const openAiChatCompletionsConfig = params.cfg.gateway?.http?.endpoints?.chatCompletions;
  const openAiChatCompletionsEnabled =
    params.openAiChatCompletionsEnabled ?? openAiChatCompletionsConfig?.enabled ?? false;
  const openResponsesConfig = params.cfg.gateway?.http?.endpoints?.responses;
  const openResponsesEnabled = params.openResponsesEnabled ?? openResponsesConfig?.enabled ?? false;
  const strictTransportSecurityConfig =
    params.cfg.gateway?.http?.securityHeaders?.strictTransportSecurity;
  const strictTransportSecurityHeader =
    strictTransportSecurityConfig === false
      ? undefined
      : typeof strictTransportSecurityConfig === "string" &&
          strictTransportSecurityConfig.trim().length > 0
        ? strictTransportSecurityConfig.trim()
        : undefined;
  const controlUiBasePath = normalizeControlUiBasePath(params.cfg.gateway?.controlUi?.basePath);
  const controlUiRootRaw = params.cfg.gateway?.controlUi?.root;
  const controlUiRoot =
    typeof controlUiRootRaw === "string" && controlUiRootRaw.trim().length > 0
      ? controlUiRootRaw.trim()
      : undefined;
  const tailscaleBase = params.cfg.gateway?.tailscale ?? {};
  const tailscaleOverrides = params.tailscale ?? {};
  const tailscaleConfig = mergeGatewayTailscaleConfig(tailscaleBase, tailscaleOverrides);
  const tailscaleMode = tailscaleConfig.mode ?? "off";
  const resolvedAuth = resolveGatewayAuth({
    authConfig: params.cfg.gateway?.auth,
    authOverride: params.auth,
    env: process.env,
    tailscaleMode,
  });
  const authMode: ResolvedGatewayAuth["mode"] = resolvedAuth.mode;
  const hasToken = typeof resolvedAuth.token === "string" && resolvedAuth.token.trim().length > 0;
  const hasPassword =
    typeof resolvedAuth.password === "string" && resolvedAuth.password.trim().length > 0;
  const hasSharedSecret =
    (authMode === "token" && hasToken) || (authMode === "password" && hasPassword);
  const hooksConfig = resolveHooksConfig(params.cfg);
  const canvasHostEnabled =
    process.env.OPENCLAW_SKIP_CANVAS_HOST !== "1" && params.cfg.canvasHost?.enabled !== false;

  const trustedProxies = params.cfg.gateway?.trustedProxies ?? [];
  const configControlUiAllowedOrigins = (params.cfg.gateway?.controlUi?.allowedOrigins ?? [])
    .map((value) => value.trim())
    .filter(Boolean);
  const envControlUiAllowedOrigins = parseControlUiAllowedOriginsFromEnv();
  const controlUiAllowedOrigins =
    envControlUiAllowedOrigins.length > 0 ? envControlUiAllowedOrigins : configControlUiAllowedOrigins;
  const envDangerousFallback = resolveControlUiHostHeaderFallbackFromEnv();
  const dangerouslyAllowHostHeaderOriginFallback =
    envDangerousFallback ??
    (params.cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true);

  assertGatewayAuthConfigured(resolvedAuth, params.cfg.gateway?.auth);
  if (tailscaleMode === "funnel" && authMode !== "password") {
    throw new Error(
      "tailscale funnel requires gateway auth mode=password (set gateway.auth.password or OPENCLAW_GATEWAY_PASSWORD)",
    );
  }
  if (tailscaleMode !== "off" && !isLoopbackHost(bindHost)) {
    throw new Error("tailscale serve/funnel requires gateway bind=loopback (127.0.0.1)");
  }
  if (!isLoopbackHost(bindHost) && !hasSharedSecret && authMode !== "trusted-proxy") {
    throw new Error(
      `refusing to bind gateway to ${bindHost}:${params.port} without auth (set gateway.auth.token/password, or set OPENCLAW_GATEWAY_TOKEN/OPENCLAW_GATEWAY_PASSWORD)`,
    );
  }
  if (
    controlUiEnabled &&
    !isLoopbackHost(bindHost) &&
    controlUiAllowedOrigins.length === 0 &&
    !dangerouslyAllowHostHeaderOriginFallback
  ) {
    throw new Error(
      "non-loopback Control UI requires gateway.controlUi.allowedOrigins (set explicit origins), OPENCLAW_GATEWAY_CONTROLUI_ALLOWED_ORIGINS, or set gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback=true / OPENCLAW_GATEWAY_CONTROLUI_DANGEROUSLY_ALLOW_HOST_HEADER_ORIGIN_FALLBACK=true",
    );
  }

  if (authMode === "trusted-proxy") {
    if (trustedProxies.length === 0) {
      throw new Error(
        "gateway auth mode=trusted-proxy requires gateway.trustedProxies to be configured with at least one proxy IP",
      );
    }
    if (isLoopbackHost(bindHost)) {
      const hasLoopbackTrustedProxy =
        isTrustedProxyAddress("127.0.0.1", trustedProxies) ||
        isTrustedProxyAddress("::1", trustedProxies);
      if (!hasLoopbackTrustedProxy) {
        throw new Error(
          "gateway auth mode=trusted-proxy with bind=loopback requires gateway.trustedProxies to include 127.0.0.1, ::1, or a loopback CIDR",
        );
      }
    }
  }

  return {
    bindHost,
    controlUiEnabled,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig: openAiChatCompletionsConfig
      ? { ...openAiChatCompletionsConfig, enabled: openAiChatCompletionsEnabled }
      : undefined,
    openResponsesEnabled,
    openResponsesConfig: openResponsesConfig
      ? { ...openResponsesConfig, enabled: openResponsesEnabled }
      : undefined,
    strictTransportSecurityHeader,
    controlUiBasePath,
    controlUiRoot,
    resolvedAuth,
    authMode,
    tailscaleConfig,
    tailscaleMode,
    hooksConfig,
    canvasHostEnabled,
  };
}
