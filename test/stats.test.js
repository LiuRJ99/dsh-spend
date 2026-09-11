/**
 * Aggregation tests: canonical provider-id matching in plan accounting
 * (regression coverage for #10 — usage reported under an alias must land
 * in the plan card and count toward the token-plan used cost).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { buildStats, decodeStorageRecord, scanSessions } from "../lib/stats.js";

const now = Date.now();
const Flash = {
  model: "deepseek-v4-flash",
  inputPerMillion: 1,
  outputPerMillion: 1,
  cacheReadPerMillion: 0,
  cacheWritePerMillion: 0,
};
const sample = (provider, model = "deepseek-v4-flash", outputTokens = 1000) => ({
  sessionId: "s1",
  cwd: "/w",
  createdAt: now,
  time: now,
  provider,
  model,
  turn: 0,
  step: 0,
  inputTokens: 0,
  outputTokens,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

test("token plan: alias-reported usage lands on the canonical plan card", () => {
  const stats = buildStats([sample("deepseek-official")], [Flash], {}, {
    plans: [{ provider: "deepseek", type: "token", balance: 100 }],
  });
  assert.equal(stats.plans.length, 1);
  assert.equal(stats.plans[0].provider, "deepseek");
  assert.equal(stats.plans[0].type, "token");
  // 1000 output tokens at $1/M → $0.001, counted through the alias.
  assert.ok(Math.abs(stats.plans[0].usedCost - 0.001) < 1e-9, `usedCost=${stats.plans[0].usedCost}`);
  assert.ok(Math.abs(stats.plans[0].remaining - (100 - 0.001)) < 1e-9);
});

test("token plan: usage from BOTH spellings of one provider adds up once", () => {
  const stats = buildStats(
    [sample("deepseek-official", "deepseek-v4-flash", 1000), sample("deepseek", "deepseek-v4-flash", 1000)],
    [Flash],
    {},
    { plans: [{ provider: "deepseek", type: "token", balance: 100 }] },
  );
  assert.equal(stats.plans.length, 1);
  assert.ok(Math.abs(stats.plans[0].usedCost - 0.002) < 1e-9, `usedCost=${stats.plans[0].usedCost}`);
});

test("code plan: quota windows accumulate alias-reported usage", () => {
  const stats = buildStats([sample("glm"), sample("glm")], [], {}, {
    plans: [{ provider: "zhipu", type: "code", quota: { requestsPerWeek: 100 } }],
  });
  assert.equal(stats.plans.length, 1);
  assert.equal(stats.plans[0].provider, "zhipu");
  assert.equal(stats.plans[0].usedRequests, 2);
  assert.equal(stats.plans[0].remainingRequests, 98);
});

test("non-alias providers keep their exact match behavior", () => {
  const stats = buildStats([sample("opencode-go"), sample("opencode-go")], [], {}, {
    plans: [{ provider: "opencode-go", type: "code", quota: { requestsPerWeek: 100 } }],
  });
  assert.equal(stats.plans.length, 1);
  assert.equal(stats.plans[0].provider, "opencode-go");
  assert.equal(stats.plans[0].usedRequests, 2);
});

test("same model names remain separate across providers", () => {
  const stats = buildStats([
    sample("openai", "shared-model", 1000),
    sample("openrouter", "shared-model", 2000),
  ], [], {});
  assert.equal(stats.byModel.length, 2);
  assert.deepEqual(new Set(stats.byModel.map((row) => row.provider)), new Set(["openai", "openrouter"]));
  assert.equal(stats.bySessionModel.length, 2);
});

test("minimax-cn alias usage lands on the minimax code plan windows", () => {
  const stats = buildStats([sample("minimax-cn"), sample("minimax-cn")], [], {}, {
    plans: [{ provider: "minimax", type: "code", quota: { requestsPerWeek: 100 } }],
  });
  assert.equal(stats.plans.length, 1);
  assert.equal(stats.plans[0].provider, "minimax");
  assert.equal(stats.plans[0].type, "code");
  assert.equal(stats.plans[0].usedRequests, 2);
  assert.equal(stats.plans[0].remainingRequests, 98);
});

test("scanSessions streams zstd frames and reuses unchanged durable files", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-spend-stats-"));
  const sessionDir = join(root, "workspace", "s1");
  const file = join(sessionDir, "session.jsonl.zstd");
  const now = Date.now();
  const writeSession = async (outputTokens) => {
    const frames = [
      [
        { type: "session", id: "s1", cwd: "/workspace", createdAt: now },
        { type: "request/header", data: { header: { config: { provider: "deepseek", model: "deepseek-v4" } } } },
        { type: "step/start", data: { turn: 0, step: 0 } },
      ],
      [
        { type: "assistant/chunk", data: { turn: 0, step: 0, chunk: { type: "usage", usage: { outputTokens: outputTokens - 1 } } } },
        { type: "assistant/message", data: { turn: 0, step: 0, usage: { outputTokens } } },
      ],
    ];
    await writeFile(
      file,
      Buffer.concat(frames.map((events) => zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`)))),
    );
  };

  try {
    await mkdir(sessionDir, { recursive: true });
    await writeSession(2);
    const fileCache = new Map();
    const first = await scanSessions(root, [], fileCache);
    assert.equal(first.totalSessions, 1);
    assert.equal(first.decodeErrors, 0);
    assert.equal(first.calls.length, 1);
    assert.equal(first.calls[0].outputTokens, 2);

    const reused = await scanSessions(root, [], fileCache);
    assert.deepEqual(reused.calls, first.calls);
    assert.equal(fileCache.size, 1);

    await writeSession(3);
    const changedAt = new Date(Date.now() + 2000);
    await utimes(file, changedAt, changedAt);
    const updated = await scanSessions(root, [], fileCache);
    assert.equal(updated.totalSessions, 1);
    assert.equal(updated.decodeErrors, 0);
    assert.equal(updated.calls.length, 1);
    assert.equal(updated.calls[0].outputTokens, 3);

    // A live session already owns the complete event snapshot. Its durable
    // file may still be mid-write, so the scanner must not decode it again.
    await writeFile(file, Buffer.from("incomplete zstd frame"));
    const live = await scanSessions(root, [{
      id: "s1",
      events: [
        { type: "session", id: "s1", cwd: "/workspace", createdAt: now },
        { type: "request/header", data: { header: { config: { provider: "deepseek", model: "deepseek-v4" } } } },
        { type: "step/start", data: { turn: 0, step: 0 } },
        { type: "assistant/message", data: { turn: 0, step: 0, usage: { outputTokens: 4 } } },
      ],
      header: { cwd: "/workspace", createdAt: now },
    }], fileCache);
    assert.equal(live.totalSessions, 1);
    assert.equal(live.decodeErrors, 0);
    assert.equal(live.calls.length, 1);
    assert.equal(live.calls[0].outputTokens, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scanSessions expands persisted packed chunk rows for performance metrics", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-spend-packed-"));
  const sessionDir = join(root, "workspace", "s-packed");
  const file = join(sessionDir, "session.jsonl.zstd");
  const now = Date.now();
  const events = [
    { type: "session", id: "s-packed", cwd: "/workspace", createdAt: now },
    { type: "request/header", time: now, data: { header: { config: { provider: "deepseek", model: "deepseek-v4" } } } },
    { type: "step/start", time: now + 10, data: { turn: 0, step: 0 } },
    {
      type: "text-chunks",
      seq0: 3,
      time0: now + 20,
      data: { turn: 0, step: 0, index: 0, dt: [5, 5], texts: ["a", "b", "c"] },
    },
    { type: "assistant/message", time: now + 40, data: { turn: 0, step: 0, usage: { outputTokens: 10 } } },
  ];
  try {
    await mkdir(sessionDir, { recursive: true });
    await writeFile(file, zstdCompressSync(Buffer.from(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`)));
    const scanned = await scanSessions(root);
    assert.equal(scanned.decodeErrors, 0);
    assert.equal(scanned.calls.length, 1);
    assert.equal(scanned.calls[0].perf.ttftMs, 20);
    assert.equal(scanned.calls[0].perf.genMs, 10);

    // Verify inline decoding for reasoning-chunks, tool-call-chunks, native events, and edge cases
    assert.deepEqual(decodeStorageRecord({
      type: "reasoning-chunks",
      seq0: 1,
      time0: 100,
      data: { turn: 0, step: 0, index: 0, dt: [10], texts: ["r1", "r2"] },
    }), [
      { type: "assistant/chunk", seq: 1, time: 100, data: { turn: 0, step: 0, chunk: { type: "reasoning-delta", index: 0, text: "r1" } } },
      { type: "assistant/chunk", seq: 2, time: 110, data: { turn: 0, step: 0, chunk: { type: "reasoning-delta", index: 0, text: "r2" } } },
    ]);

    assert.deepEqual(decodeStorageRecord({
      type: "tool-call-chunks",
      seq0: 5,
      time0: 200,
      data: { turn: 0, step: 0, index: 0, id: "call_1", name: "bash", dt: [20], args: ["{\"cmd\":", "\"ls\"}"] },
    }), [
      { type: "assistant/chunk", seq: 5, time: 200, data: { turn: 0, step: 0, chunk: { type: "tool-call-delta", index: 0, id: "call_1", name: "bash", argumentsDelta: "{\"cmd\":" } } },
      { type: "assistant/chunk", seq: 6, time: 220, data: { turn: 0, step: 0, chunk: { type: "tool-call-delta", index: 0, id: "call_1", name: "bash", argumentsDelta: "\"ls\"}" } } },
    ]);

    const nativeEvent = { type: "step/start", time: 300, data: { turn: 0, step: 0 } };
    assert.deepEqual(decodeStorageRecord(nativeEvent), [nativeEvent]);
    assert.deepEqual(decodeStorageRecord(null), [null]);
    assert.deepEqual(decodeStorageRecord("invalid"), ["invalid"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
