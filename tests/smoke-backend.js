#!/usr/bin/env node
/**
 * Manual smoke test for the AI-fallback backend (server/server.js).
 *
 * Unlike engine.test.js / server-extract-result.test.js (which run offline
 * as part of `npm test`), this script makes REAL calls to the running
 * backend + Qwen API, so it costs a few cents and needs:
 *
 *   1. `cd server && npm start`   (with QWEN_API_KEY set in server/.env)
 *   2. `node tests/smoke-backend.js`   (from the project root, in a new terminal)
 *
 * It sends a handful of notepads that the local rule engine deliberately
 * can't solve (dates, currency conversion, plain notes) and checks that the
 * AI fallback behaves sensibly. Since LLM output isn't 100% deterministic,
 * checks are loose (e.g. "looks like a date") rather than exact-match.
 */

const BASE = process.env.FALLBACK_BASE || "http://localhost:8787";

const cases = [
  {
    name: "relative date arithmetic",
    lines: ["three weeks from today"],
    lineIndex: 0,
    expectType: "text",
    check: (v) => /\d{4}/.test(v), // should mention a year
  },
  {
    name: "currency conversion using live rates",
    lines: ["100 dollars in RMB"],
    lineIndex: 0,
    expectType: "text",
    check: (v) => /[\d.,]/.test(v), // should contain a number
  },
  {
    name: "variable defined earlier, used in a date-ish line",
    lines: ["trip length = 10 days", "trip length from today"],
    lineIndex: 1,
    expectType: "text",
    check: (v) => /\d{4}/.test(v),
  },
  {
    name: "plain note must NOT get a hallucinated answer",
    lines: ["just some notes about today's meeting, nothing to calculate"],
    lineIndex: 0,
    expectType: null,
    check: (v) => v === null,
  },
  {
    name: "TODO-style line must NOT get a hallucinated answer",
    lines: ["TODO: buy groceries and walk the dog"],
    lineIndex: 0,
    expectType: null,
    check: (v) => v === null,
  },
];

async function runCase(c) {
  const res = await fetch(`${BASE}/api/evaluate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines: c.lines, lineIndex: c.lineIndex }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const value = c.expectType === null ? data.result : data.result;
  const pass = c.check(value);
  return { pass, data };
}

async function main() {
  console.log(`Smoke-testing AI fallback backend at ${BASE}\n`);

  let health;
  try {
    health = await (await fetch(`${BASE}/api/health`)).json();
  } catch (e) {
    console.error(`✗ Cannot reach ${BASE} — is the backend running? (cd server && npm start)`);
    process.exit(1);
  }
  if (!health.hasKey) {
    console.error("✗ Backend is up but has no QWEN_API_KEY configured (server/.env). Aborting.");
    process.exit(1);
  }
  console.log(`✓ Backend online, model = ${health.model}\n`);

  let failures = 0;
  for (const c of cases) {
    try {
      const { pass, data } = await runCase(c);
      console.log(`${pass ? "✓" : "✗"} ${c.name}`);
      console.log(`  input: ${JSON.stringify(c.lines)} (line ${c.lineIndex + 1})`);
      console.log(`  got:   result=${JSON.stringify(data.result)} type=${data.resultType}`);
      if (!pass) failures++;
    } catch (e) {
      console.log(`✗ ${c.name} — request failed: ${e.message}`);
      failures++;
    }
    console.log("");
  }

  if (failures) {
    console.error(`${failures}/${cases.length} smoke case(s) failed.`);
    process.exit(1);
  }
  console.log(`All ${cases.length} smoke cases passed.`);
}

main();
