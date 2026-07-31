/**
 * Smoke/regression tests for the local rule engine (engine.js).
 *
 * These are fast, deterministic, and need no network or backend server —
 * run them after every feature change with:
 *
 *   npm test
 *
 * They do NOT cover the AI fallback (Qwen) path, since that needs the
 * backend running and a live API key. For that, see tests/smoke-backend.js.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

global.math = require("mathjs");
const { evaluateLines, transformExpr, slugify } = require("../engine.js");

// Returns the array of result strings for a multi-line notepad string.
function evalText(text) {
  return evaluateLines(text).results;
}

// Convenience for the common case of a single-line expression.
function evalLine(line) {
  return evalText(line)[0];
}

test("basic arithmetic", () => {
  assert.equal(evalLine("(10 + 5) * 2"), "30");
  assert.equal(evalLine("10 - 4 / 2"), "8");
  assert.equal(evalLine("2 ^ 3"), "8");
});

test("percentages", () => {
  assert.equal(evalLine("15% of 95"), "14.25");
  assert.equal(evalLine("8 percent of 200"), "16");
  assert.equal(evalLine("20%"), "0.2");
});

test("aggregate functions (sum / average / max / min)", () => {
  assert.equal(evalLine("sum of 4, 23.4, 45, 67, 90"), "229.4");
  assert.equal(evalLine("total of 1, 2, 3"), "6");
  assert.equal(evalLine("average of 3, 4, 5"), "4");
  assert.equal(evalLine("avg of 10, 20"), "15");
  assert.equal(evalLine("max of 3, 9, 1"), "9");
  assert.equal(evalLine("min of 3, 9, 1"), "1");
});

test("word operators", () => {
  assert.equal(evalLine("4 plus 5"), "9");
  assert.equal(evalLine("10 minus 3"), "7");
  assert.equal(evalLine("6 times 7"), "42");
  assert.equal(evalLine("20 divided by 4"), "5");
  assert.equal(evalLine("9 multiplied by 2"), "18");
  assert.equal(evalLine("10 over 2"), "5");
});

test("unary phrases: decimal/integer part, sqrt, abs, square, cube", () => {
  assert.equal(evalLine("the decimal part of 10.2"), "0.2");
  assert.equal(evalLine("the integer part of 10.7"), "10");
  assert.equal(evalLine("square root of 81"), "9");
  assert.equal(evalLine("the absolute value of -5"), "5");
  assert.equal(evalLine("the square of 4"), "16");
  assert.equal(evalLine("the cube of 3"), "27");
});

test("filler words / question phrasing are stripped", () => {
  assert.equal(evalLine("what is 5 + 5"), "10");
  assert.equal(evalLine("what's 5 + 5?"), "10");
  assert.equal(evalLine("calculate 5 + 5"), "10");
  assert.equal(evalLine("how much is 5 + 5"), "10");
});

test("single-word variable assignment and reuse", () => {
  const results = evalText(["price = 120", "tax = 8% of price", "price + tax"].join("\n"));
  assert.deepEqual(results, ["120", "9.6", "129.6"]);
});

test('natural-language assignment with "is" / "equals" (regression)', () => {
  // Previously unsupported: only "name = value" worked, not "name is value".
  const results = evalText(["daily transport fee is 7", "daily transport fee times 7"].join("\n"));
  assert.deepEqual(results, ["7", "49"]);

  assert.deepEqual(evalText("price = 10\nprice equals 20\nprice + 1"), ["10", "20", "21"]);
});

test('"is" assignment does not break question phrasing ("what is", "how much is")', () => {
  assert.equal(evalLine("what is 5 + 5"), "10");
  assert.equal(evalLine("how much is 5 + 5"), "10");
});

test("multi-word variable assignment and reuse (regression)", () => {
  // Previously unsupported: "daily snack cost" as a variable name.
  const results = evalText(
    ["daily snack cost = $5", "weekly snack cost = 7 * daily snack cost"].join("\n")
  );
  assert.deepEqual(results, ["5", "35"]);
});

test("currency symbols are stripped from numbers (regression)", () => {
  assert.equal(evalLine("$5 + $3"), "8");
  assert.equal(evalLine("¥100 * 2"), "200");
});

test("comments and blank lines produce no result", () => {
  const results = evalText(["// just a note", "# another note", "", "1 + 1"].join("\n"));
  assert.deepEqual(results, ["", "", "", "2"]);
});

test("plain text / unparseable lines produce no result (no hallucinated answers)", () => {
  assert.equal(evalLine("just some notes about today"), "");
  assert.equal(evalLine("hello world"), "");
});

test("large numbers are formatted with thousands separators", () => {
  assert.equal(evalLine("1000000 + 1"), "1,000,001");
});

test("transformExpr and slugify helpers", () => {
  assert.equal(transformExpr("15% of 95"), "((15)/100*(95))");
  assert.equal(slugify("Daily Snack Cost"), "daily_snack_cost");
  assert.equal(slugify("2nd variable"), "_2nd_variable");
});
