import "dotenv/config";
import * as path from "node:path";
import type { AppConfig, OrderSizeModeName, SignatureTypeName } from "./types";

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

function normalizeAddress(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`Invalid ${label}: ${value || "(empty)"}`);
  }
  return normalized;
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

export function resolveSqlitePath(cwd = process.cwd()): string {
  return path.resolve(
    cwd,
    asString(process.env.POLYCOPY_V2_DB_PATH) || path.join("data", "polycopy-v2.sqlite")
  );
}

export function loadConfig(): AppConfig {
  const leaderWalletRaw = asString(process.env.LEADER_WALLET_ADDRESS);
  const followerWalletRaw = asString(process.env.FOLLOWER_WALLET_ADDRESS);
  if (!leaderWalletRaw) {
    throw new Error("Missing LEADER_WALLET_ADDRESS");
  }
  if (!followerWalletRaw) {
    throw new Error("Missing FOLLOWER_WALLET_ADDRESS");
  }

  const sqlitePath = resolveSqlitePath(process.cwd());

  return {
    leaderWallet: normalizeAddress(leaderWalletRaw, "leader wallet"),
    followerWallet: normalizeAddress(followerWalletRaw, "follower wallet"),
    proxyWalletAddress: asString(process.env.PROXY_WALLET_ADDRESS).toLowerCase(),
    walletPrivateKey: asString(process.env.WALLET_PRIVATE_KEY),
    apiKey: asString(process.env.POLYMARKET_API_KEY),
    apiSecret: asString(process.env.POLYMARKET_API_SECRET),
    apiPassphrase: asString(process.env.POLYMARKET_API_PASSPHRASE),
    sqlitePath,
    simulationMode: asBoolean(process.env.SIMULATION_MODE, true),
    orderSizeMode: normalizeOrderSizeMode(asString(process.env.ORDER_SIZE_MODE) || "fixed"),
    fixedOrderSize: asNumber(process.env.FIXED_ORDER_SIZE, 5),
    sizeMultiplier: asNumber(process.env.SIZE_MULTIPLIER, 1),
    clobHttpUrl: asString(process.env.CLOB_HTTP_URL) || "https://clob.polymarket.com",
    chainId: asNumber(process.env.CHAIN_ID, 137),
    signatureType: normalizeSignatureType(asString(process.env.SIGNATURE_TYPE) || "EOA"),
    tuiEnabled: asBoolean(process.env.POLYCOPY_V2_TUI, false),
  };
}
