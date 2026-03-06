import { ClobClient, type ApiKeyCreds, type Chain, type OpenOrder, type Trade } from "@polymarket/clob-client";
import { SignatureType } from "@polymarket/order-utils";
import { Wallet } from "ethers";
import type { AppConfig, SignatureTypeName } from "./types";

function toSignatureType(value: SignatureTypeName): SignatureType {
  switch (value) {
    case "POLY_PROXY":
      return SignatureType.POLY_PROXY;
    case "POLY_GNOSIS_SAFE":
      return SignatureType.POLY_GNOSIS_SAFE;
    default:
      return SignatureType.EOA;
  }
}

function asApiCreds(value: unknown): ApiKeyCreds | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as { key?: unknown; secret?: unknown; passphrase?: unknown };
  if (
    typeof raw.key !== "string" ||
    typeof raw.secret !== "string" ||
    typeof raw.passphrase !== "string" ||
    raw.key.trim() === "" ||
    raw.secret.trim() === "" ||
    raw.passphrase.trim() === ""
  ) {
    return null;
  }

  return {
    key: raw.key,
    secret: raw.secret,
    passphrase: raw.passphrase,
  };
}

function normalizePrivateKey(privateKey: string): string | null {
  if (!privateKey) {
    return null;
  }
  return privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
}

function buildApiCreds(config: AppConfig): ApiKeyCreds | null {
  if (!config.apiKey || !config.apiSecret || !config.apiPassphrase) {
    return null;
  }
  return {
    key: config.apiKey,
    secret: config.apiSecret,
    passphrase: config.apiPassphrase,
  };
}

async function resolveApiCreds(client: ClobClient): Promise<ApiKeyCreds> {
  const derived = asApiCreds(await client.deriveApiKey());
  if (derived) {
    return derived;
  }
  const created = asApiCreds(await client.createApiKey());
  if (created) {
    return created;
  }
  throw new Error("Unable to derive or create Polymarket API credentials.");
}

export function resolveFunderAddress(config: AppConfig): string {
  return config.proxyWalletAddress || config.followerWallet;
}

export async function createAuthenticatedClobClient(config: AppConfig): Promise<ClobClient> {
  const privateKey = normalizePrivateKey(config.walletPrivateKey);
  if (!privateKey) {
    throw new Error("Missing WALLET_PRIVATE_KEY");
  }

  const signer = new Wallet(privateKey);
  const signatureType = toSignatureType(config.signatureType);
  const funderAddress = resolveFunderAddress(config);
  const baseClient = new ClobClient(
    config.clobHttpUrl,
    config.chainId as Chain,
    signer,
    undefined,
    signatureType,
    funderAddress
  );

  const creds = buildApiCreds(config) ?? (await resolveApiCreds(baseClient));
  return new ClobClient(
    config.clobHttpUrl,
    config.chainId as Chain,
    signer,
    creds,
    signatureType,
    funderAddress
  );
}

export interface OrderTrackerClient {
  getOrder(orderId: string): Promise<OpenOrder>;
  getTrades(params?: { asset_id?: string; id?: string }, onlyFirstPage?: boolean): Promise<Trade[]>;
}
