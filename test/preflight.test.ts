import assert from "node:assert/strict";
import test from "node:test";
import { collectStartupChecks, renderStartupChecks, validateStartupChecks } from "../src/preflight";

test("collectStartupChecks reports derive/create when live mode has no explicit api creds", () => {
  const checks = collectStartupChecks({
    LEADER_WALLET_ADDRESS: "0x1111111111111111111111111111111111111111",
    FOLLOWER_WALLET_ADDRESS: "0x2222222222222222222222222222222222222222",
    PROXY_WALLET_ADDRESS: "0x3333333333333333333333333333333333333333",
    WALLET_PRIVATE_KEY: "0xabc",
    SIGNATURE_TYPE: "POLY_PROXY",
    SIMULATION_MODE: "false",
  });

  assert.deepEqual(checks.find((check) => check.label === "api credentials"), {
    label: "api credentials",
    status: "warn",
    detail: "POLYMARKET_API_* missing, will derive/create from WALLET_PRIVATE_KEY",
  });
});

test("collectStartupChecks reports explicit api creds when all are present", () => {
  const checks = collectStartupChecks({
    LEADER_WALLET_ADDRESS: "0x1111111111111111111111111111111111111111",
    FOLLOWER_WALLET_ADDRESS: "0x2222222222222222222222222222222222222222",
    PROXY_WALLET_ADDRESS: "0x3333333333333333333333333333333333333333",
    WALLET_PRIVATE_KEY: "0xabc",
    SIGNATURE_TYPE: "POLY_PROXY",
    SIMULATION_MODE: "false",
    POLYMARKET_API_KEY: "key",
    POLYMARKET_API_SECRET: "secret",
    POLYMARKET_API_PASSPHRASE: "passphrase",
  });

  assert.deepEqual(checks.find((check) => check.label === "api credentials"), {
    label: "api credentials",
    status: "ok",
    detail: "explicit POLYMARKET_API_* provided",
  });
});

test("renderStartupChecks prints a readable startup summary", () => {
  const output = renderStartupChecks(
    [
      { label: "runtime", status: "ok", detail: "simulation | tui=on" },
      { label: "api credentials", status: "warn", detail: "not required in simulation" },
    ],
    5000
  );

  assert.match(output, /\[startup preflight\]/);
  assert.match(output, /\[OK\] runtime: simulation \| tui=on/);
  assert.match(output, /\[WARN\] api credentials: not required in simulation/);
  assert.match(output, /Starting runtime in 5 seconds/);
});

test("validateStartupChecks performs connectivity, signer, and auth validation", async () => {
  const checks = await validateStartupChecks(
    {
      LEADER_WALLET_ADDRESS: "0x1111111111111111111111111111111111111111",
      FOLLOWER_WALLET_ADDRESS: "0x2222222222222222222222222222222222222222",
      PROXY_WALLET_ADDRESS: "0x3333333333333333333333333333333333333333",
      WALLET_PRIVATE_KEY: "0xabc",
      SIGNATURE_TYPE: "POLY_PROXY",
      SIMULATION_MODE: "false",
    },
    {
      createPublicClobClient() {
        return {
          async getOk() {
            return { ok: true };
          },
        };
      },
      createWallet() {
        return {
          address: "0x4444444444444444444444444444444444444444",
        };
      },
      async createAuthenticatedClobClient() {
        return {
          async getApiKeys() {
            return { apiKeys: [{ key: "k" }, { key: "k2" }] };
          },
        };
      },
    }
  );

  assert.deepEqual(checks.find((check) => check.label === "clob connectivity"), {
    label: "clob connectivity",
    status: "ok",
    detail: "public CLOB endpoint reachable",
  });
  assert.deepEqual(checks.find((check) => check.label === "signer validation"), {
    label: "signer validation",
    status: "ok",
    detail: "EOA 0x4444...4444",
  });
  assert.deepEqual(checks.find((check) => check.label === "api auth validation"), {
    label: "api auth validation",
    status: "ok",
    detail: "derive/create verified | apiKeys=2",
  });
});

test("validateStartupChecks reports auth validation errors", async () => {
  const checks = await validateStartupChecks(
    {
      LEADER_WALLET_ADDRESS: "0x1111111111111111111111111111111111111111",
      FOLLOWER_WALLET_ADDRESS: "0x2222222222222222222222222222222222222222",
      PROXY_WALLET_ADDRESS: "0x3333333333333333333333333333333333333333",
      WALLET_PRIVATE_KEY: "0xabc",
      SIGNATURE_TYPE: "POLY_PROXY",
      SIMULATION_MODE: "false",
    },
    {
      createPublicClobClient() {
        return {
          async getOk() {
            return { ok: true };
          },
        };
      },
      createWallet() {
        return {
          address: "0x4444444444444444444444444444444444444444",
        };
      },
      async createAuthenticatedClobClient() {
        throw new Error("bad api creds");
      },
    }
  );

  assert.deepEqual(checks.find((check) => check.label === "api auth validation"), {
    label: "api auth validation",
    status: "error",
    detail: "bad api creds",
  });
});
