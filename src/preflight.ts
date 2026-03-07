import { ClobClient, type Chain } from "@polymarket/clob-client";
import { Wallet } from "ethers";
import { errorMessage } from "./logger";
import { loadConfigFromEnv } from "./config";
import { createAuthenticatedClobClient } from "./polymarket";
import type { AppConfig, OrderSizeModeName, SignatureTypeName } from "./types";

export interface StartupCheck {
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
}

interface PublicClobProbe {
  getOk(): Promise<unknown>;
}

interface AuthenticatedClobProbe {
  getApiKeys(): Promise<{ apiKeys?: unknown[] }>;
}

export interface StartupValidationDeps {
  createPublicClobClient(host: string, chainId: number): PublicClobProbe;
  createWallet(privateKey: string): { address: string };
  createAuthenticatedClobClient(config: AppConfig): Promise<AuthenticatedClobProbe>;
}

const defaultStartupValidationDeps: StartupValidationDeps = {
  createPublicClobClient(host, chainId) {
    return new ClobClient(host, chainId as Chain);
  },
  createWallet(privateKey) {
    return new Wallet(privateKey);
  },
  createAuthenticatedClobClient,
};

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function normalizeSignatureType(value: string): SignatureTypeName {
  const normalized = value.trim().toUpperCase();
  if (normalized === "POLY_PROXY" || normalized === "POLY_GNOSIS_SAFE") {
    return normalized;
  }
  return "EOA";
}

function normalizeOrderSizeMode(value: string): OrderSizeModeName {
  const normalized = value.trim().toLowerCase();
  return normalized === "multiplier" ? "multiplier" : "fixed";
}

function isValidAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

function compactAddress(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 14) {
    return trimmed;
  }
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
}

function normalizePrivateKey(value: string): string | null {
  if (!value) {
    return null;
  }
  return value.startsWith("0x") ? value : `0x${value}`;
}

function hasAllApiCreds(env: NodeJS.ProcessEnv): boolean {
  return Boolean(asString(env.POLYMARKET_API_KEY) && asString(env.POLYMARKET_API_SECRET) && asString(env.POLYMARKET_API_PASSPHRASE));
}

function hasAnyApiCreds(env: NodeJS.ProcessEnv): boolean {
  return Boolean(asString(env.POLYMARKET_API_KEY) || asString(env.POLYMARKET_API_SECRET) || asString(env.POLYMARKET_API_PASSPHRASE));
}

export function collectStartupChecks(env: NodeJS.ProcessEnv): StartupCheck[] {
  const simulationMode = asBoolean(env.SIMULATION_MODE, true);
  const tuiEnabled = asBoolean(env.POLYCOPY_V2_TUI, false);
  const leaderWallet = asString(env.LEADER_WALLET_ADDRESS);
  const followerWallet = asString(env.FOLLOWER_WALLET_ADDRESS);
  const proxyWallet = asString(env.PROXY_WALLET_ADDRESS);
  const signatureType = normalizeSignatureType(asString(env.SIGNATURE_TYPE) || "EOA");
  const orderSizeMode = normalizeOrderSizeMode(asString(env.ORDER_SIZE_MODE) || "fixed");
  const fixedOrderSize = asNumber(env.FIXED_ORDER_SIZE, 5);
  const sizeMultiplier = asNumber(env.SIZE_MULTIPLIER, 1);
  const walletPrivateKey = asString(env.WALLET_PRIVATE_KEY);
  const clobHttpUrl = asString(env.CLOB_HTTP_URL) || "https://clob.polymarket.com";
  const chainId = asNumber(env.CHAIN_ID, 137);

  const checks: StartupCheck[] = [
    {
      label: "runtime",
      status: "ok",
      detail: `${simulationMode ? "simulation" : "live"} | tui=${tuiEnabled ? "on" : "off"}`,
    },
    {
      label: "leader wallet",
      status: leaderWallet && isValidAddress(leaderWallet) ? "ok" : "error",
      detail: leaderWallet && isValidAddress(leaderWallet) ? compactAddress(leaderWallet) : "missing or invalid LEADER_WALLET_ADDRESS",
    },
    {
      label: "follower wallet",
      status: followerWallet && isValidAddress(followerWallet) ? "ok" : "error",
      detail:
        followerWallet && isValidAddress(followerWallet)
          ? compactAddress(followerWallet)
          : "missing or invalid FOLLOWER_WALLET_ADDRESS",
    },
  ];

  if (signatureType === "POLY_PROXY" || signatureType === "POLY_GNOSIS_SAFE") {
    checks.push({
      label: "proxy wallet",
      status: proxyWallet && isValidAddress(proxyWallet) ? "ok" : "error",
      detail:
        proxyWallet && isValidAddress(proxyWallet)
          ? `${signatureType} ${compactAddress(proxyWallet)}`
          : `missing or invalid PROXY_WALLET_ADDRESS for ${signatureType}`,
    });
  } else {
    checks.push({
      label: "proxy wallet",
      status: "warn",
      detail: "not used in EOA mode",
    });
  }

  checks.push({
    label: "order size",
    status:
      orderSizeMode === "fixed"
        ? fixedOrderSize > 0
          ? "ok"
          : "error"
        : sizeMultiplier > 0
          ? "ok"
          : "error",
    detail:
      orderSizeMode === "fixed"
        ? `fixed size=${fixedOrderSize}`
        : `multiplier sizeMultiplier=${sizeMultiplier}`,
  });

  checks.push({
    label: "clob",
    status: "ok",
    detail: `${clobHttpUrl} chain=${chainId}`,
  });

  if (
    proxyWallet &&
    followerWallet &&
    isValidAddress(proxyWallet) &&
    isValidAddress(followerWallet) &&
    proxyWallet.toLowerCase() === followerWallet.toLowerCase()
  ) {
    checks.push({
      label: "wallet topology",
      status: "warn",
      detail: "FOLLOWER_WALLET_ADDRESS matches PROXY_WALLET_ADDRESS; usually follower is profile/funder and proxy is separate",
    });
  }

  if (simulationMode) {
    checks.push({
      label: "wallet key",
      status: walletPrivateKey ? "warn" : "ok",
      detail: walletPrivateKey ? "present but not required in simulation" : "not required in simulation",
    });
    checks.push({
      label: "api credentials",
      status: hasAnyApiCreds(env) ? "warn" : "ok",
      detail: hasAllApiCreds(env)
        ? "explicit POLYMARKET_API_* provided but not required in simulation"
        : hasAnyApiCreds(env)
          ? "incomplete POLYMARKET_API_* provided but not required in simulation"
          : "not required in simulation",
    });
    return checks;
  }

  checks.push({
    label: "wallet key",
    status: walletPrivateKey ? "ok" : "error",
    detail: walletPrivateKey ? "present" : "missing WALLET_PRIVATE_KEY",
  });

  if (hasAllApiCreds(env)) {
    checks.push({
      label: "api credentials",
      status: "ok",
      detail: "explicit POLYMARKET_API_* provided",
    });
  } else if (hasAnyApiCreds(env)) {
    checks.push({
      label: "api credentials",
      status: walletPrivateKey ? "warn" : "error",
      detail: walletPrivateKey
        ? "incomplete POLYMARKET_API_* provided, will try derive/create from WALLET_PRIVATE_KEY"
        : "incomplete POLYMARKET_API_* provided and WALLET_PRIVATE_KEY is missing",
    });
  } else {
    checks.push({
      label: "api credentials",
      status: walletPrivateKey ? "warn" : "error",
      detail: walletPrivateKey
        ? "POLYMARKET_API_* missing, will derive/create from WALLET_PRIVATE_KEY"
        : "POLYMARKET_API_* missing and WALLET_PRIVATE_KEY is missing",
    });
  }

  return checks;
}

export async function validateStartupChecks(
  env: NodeJS.ProcessEnv,
  deps: StartupValidationDeps = defaultStartupValidationDeps
): Promise<StartupCheck[]> {
  const checks = collectStartupChecks(env);
  const simulationMode = asBoolean(env.SIMULATION_MODE, true);
  const clobHttpUrl = asString(env.CLOB_HTTP_URL) || "https://clob.polymarket.com";
  const chainId = asNumber(env.CHAIN_ID, 137);
  const walletPrivateKey = asString(env.WALLET_PRIVATE_KEY);

  try {
    const probe = deps.createPublicClobClient(clobHttpUrl, chainId);
    await probe.getOk();
    checks.push({
      label: "clob connectivity",
      status: "ok",
      detail: "public CLOB endpoint reachable",
    });
  } catch (error) {
    checks.push({
      label: "clob connectivity",
      status: "error",
      detail: errorMessage(error),
    });
  }

  if (walletPrivateKey) {
    try {
      const normalizedPrivateKey = normalizePrivateKey(walletPrivateKey);
      if (!normalizedPrivateKey) {
        throw new Error("missing WALLET_PRIVATE_KEY");
      }
      const wallet = deps.createWallet(normalizedPrivateKey);
      checks.push({
        label: "signer validation",
        status: "ok",
        detail: `EOA ${compactAddress(wallet.address)}`,
      });
    } catch (error) {
      checks.push({
        label: "signer validation",
        status: simulationMode ? "warn" : "error",
        detail: errorMessage(error),
      });
    }
  }

  if (simulationMode) {
    return checks;
  }

  try {
    const config = loadConfigFromEnv(env);
    const authClient = await deps.createAuthenticatedClobClient(config);
    const apiKeys = await authClient.getApiKeys();
    const explicitApiCreds = hasAllApiCreds(env);
    checks.push({
      label: "api auth validation",
      status: "ok",
      detail: `${explicitApiCreds ? "explicit creds verified" : "derive/create verified"} | apiKeys=${apiKeys.apiKeys?.length ?? 0}`,
    });
  } catch (error) {
    checks.push({
      label: "api auth validation",
      status: "error",
      detail: errorMessage(error),
    });
  }

  return checks;
}

function statusLabel(status: StartupCheck["status"]): string {
  switch (status) {
    case "ok":
      return "OK";
    case "warn":
      return "WARN";
    default:
      return "ERROR";
  }
}

export function renderStartupChecks(checks: StartupCheck[], delayMs: number): string {
  const lines = ["[startup preflight]"];
  for (const check of checks) {
    lines.push(`[${statusLabel(check.status)}] ${check.label}: ${check.detail}`);
  }
  lines.push(`Starting runtime in ${Math.max(0, Math.round(delayMs / 1000))} seconds...`);
  return `${lines.join("\n")}\n`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
