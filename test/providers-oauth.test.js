/** Regression tests for configurable OAuth-provider usage endpoints. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { codexFetch } from "../lib/providers/oauth-codex.js";
import { copilotFetch } from "../lib/providers/oauth-copilot.js";

const originalFetch = globalThis.fetch;

test("codex usage adapter honors a configured endpoint URL", async () => {
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        rate_limit: {
          primary_window: { used_percent: 12, reset_at: 1787616166 },
          secondary_window: { used_percent: 34, reset_at: 1787626166 },
        },
      }),
    };
  };
  try {
    const auth = JSON.stringify({ tokens: { access_token: "access", refresh_token: "refresh", account_id: "acct" } });
    const usage = await codexFetch({
      env: {},
      home: "/tmp/dsh-spend-test",
      readText: async (path) => path.endsWith("auth.json") ? auth : undefined,
    }, { url: "https://example.test/codex-usage", timeoutMs: 3210 });
    assert.equal(seen[0].url, "https://example.test/codex-usage");
    assert.equal(usage.windows["5h"].percent, 12);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Copilot adapter honors configured URL and API-key environment", async () => {
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url, options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ quota_snapshots: { chat: { percent_remaining: 75 } } }),
    };
  };
  try {
    const usage = await copilotFetch({
      env: {},
      resolveRef: async (name) => name === "CUSTOM_GH_TOKEN" ? "custom-token" : undefined,
      readText: async () => undefined,
    }, { url: "https://example.test/copilot-usage", apiKeyEnv: "CUSTOM_GH_TOKEN" });
    assert.equal(seen[0].url, "https://example.test/copilot-usage");
    assert.equal(seen[0].options.headers.Authorization, "token custom-token");
    assert.equal(usage.extra[0].percent, 25);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
