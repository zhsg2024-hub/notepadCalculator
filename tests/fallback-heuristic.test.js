/**
 * Tests for the pure helpers that decide *whether* a line should be sent to
 * the AI fallback service (not the network call itself — see
 * tests/smoke-backend.js for that).
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { lineLooksLikeCalculation, contextKey } = require("../engine.js");

test("lines with digits look like calculations", () => {
  assert.equal(lineLooksLikeCalculation("100 dollars in RMB", []), true);
});

test("date/time phrases look like calculations even without digits (regression)", () => {
  assert.equal(lineLooksLikeCalculation("three weeks from today", []), true);
  assert.equal(lineLooksLikeCalculation("next Monday", []), true);
  assert.equal(lineLooksLikeCalculation("tomorrow at noon", []), true);
});

test("lines referencing a known variable look like calculations", () => {
  assert.equal(lineLooksLikeCalculation("7 * daily snack cost", ["daily snack cost"]), true);
  assert.equal(lineLooksLikeCalculation("daily snack cost doubled", ["daily snack cost"]), true);
});

test("plain notes do not look like calculations", () => {
  assert.equal(lineLooksLikeCalculation("just some notes about today's meeting", []), true); // "today" is a signal word
  assert.equal(lineLooksLikeCalculation("remember to call mom", []), false);
  assert.equal(lineLooksLikeCalculation("hello world", []), false);
});

test("contextKey changes when an earlier line changes, not on unrelated later edits", () => {
  const before = ["price = 120", "three weeks from today"];
  const after = ["price = 130", "three weeks from today"];
  assert.notEqual(contextKey(before, 1), contextKey(after, 1));

  const sameLines = ["price = 120", "three weeks from today", "unrelated note"];
  assert.equal(contextKey(before, 1), contextKey(sameLines, 1));
});
