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
const { evaluateLines, transformExpr, slugify, highlightText, formatDate } = require("../engine.js");

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

test("percent-of a variable with a leading 'the' (regression: '10 percent of the price' had no answer)", () => {
  const results = evalText("price is 100\n10 percent of the price");
  assert.deepEqual(results, ["100", "10"]);
  // Bare "of price" (no "the") must keep working alongside the "the" form.
  assert.equal(
    evalText("price is 100\n10 percent of price")[1],
    "10"
  );
});

test("aggregate functions (sum / average / max / min)", () => {
  assert.equal(evalLine("sum of 4, 23.4, 45, 67, 90"), "229.4");
  assert.equal(evalLine("total of 1, 2, 3"), "6");
  assert.equal(evalLine("average of 3, 4, 5"), "4");
  assert.equal(evalLine("avg of 10, 20"), "15");
  assert.equal(evalLine("max of 3, 9, 1"), "9");
  assert.equal(evalLine("min of 3, 9, 1"), "1");
});

test("aggregate functions accept variables, not just literal numbers (regression: 'sum of tax, price' had no answer)", () => {
  const results = evalText("price is 100\ntax is 9% of price\nsum of tax, price");
  assert.deepEqual(results, ["100", "9", "109"]);

  const mixed = evalText("a = 10\naverage of a, 20, 30");
  assert.deepEqual(mixed, ["10", "20"]);

  // Same "the <variable>" filler as the percent-of regression above.
  const withThe = evalText("price is 100\ntax is 9% of price\nsum of the tax, the price");
  assert.deepEqual(withThe, ["100", "9", "109"]);
});

test("word operators", () => {
  assert.equal(evalLine("4 plus 5"), "9");
  assert.equal(evalLine("10 minus 3"), "7");
  assert.equal(evalLine("6 times 7"), "42");
  assert.equal(evalLine("20 divided by 4"), "5");
  assert.equal(evalLine("9 multiplied by 2"), "18");
  assert.equal(evalLine("10 over 2"), "5");
});

test("'add'/'subtract' as binary word operators (regression: '19 add 100' had no answer)", () => {
  assert.equal(evalLine("19 add 100"), "119");
  assert.equal(evalLine("50 subtract 8"), "42");
  assert.equal(evalLine("5 added to 10"), "15");
  assert.equal(evalLine("20 subtracted from 30"), "10");
  // The leading-word aggregate form ("add 4, 5, 6" => sum) must still work.
  assert.equal(evalLine("add 4, 5, 6"), "15");
});

test("unary phrases: decimal/integer part, sqrt, abs, square, cube", () => {
  assert.equal(evalLine("the decimal part of 10.2"), "0.2");
  assert.equal(evalLine("the integer part of 10.7"), "10");
  assert.equal(evalLine("square root of 81"), "9");
  assert.equal(evalLine("the absolute value of -5"), "5");
  assert.equal(evalLine("the square of 4"), "16");
  assert.equal(evalLine("the cube of 3"), "27");
});

test("square/cube also work without 'of' (regression: 'square 3' had no answer)", () => {
  assert.equal(evalLine("square 3"), "9");
  assert.equal(evalLine("cube 3"), "27");
  assert.equal(evalLine("the square 4"), "16");
  // 'of' phrasing and 'square root of' must keep working alongside the bare form.
  assert.equal(evalLine("square of 3"), "9");
  assert.equal(evalLine("square root of 81"), "9");
});

test("bare 'root of'/'root' also mean square root (regression: 'root of 9' had no answer)", () => {
  assert.equal(evalLine("root of 9"), "3");
  assert.equal(evalLine("root 9"), "3");
  assert.equal(evalLine("the root of 16"), "4");
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

test("bare verb-less assignment: '<name> <value>' (regression: 'discount 10% of price' had no answer)", () => {
  const results = evalText(["price 100", "discount 10% of price"].join("\n"));
  assert.deepEqual(results, ["100", "10"]);

  // A single-word name reassigned this way overrides its old value rather
  // than being read as implicit multiplication against it.
  assert.deepEqual(evalText("price is 100\nprice 5\nprice + 1"), ["100", "5", "6"]);

  assert.equal(evalLine("total $5"), "5");
});

test("date arithmetic works fully offline (regression: needed AI fallback before, gave no answer when AI was off)", () => {
  const jul8 = new Date(new Date().getFullYear(), 6, 8);

  const results = evalText(["today is 8 july", "three days after today"].join("\n"));
  assert.equal(results[0], formatDate(jul8));
  const jul11 = new Date(jul8);
  jul11.setDate(jul11.getDate() + 3);
  assert.equal(results[1], formatDate(jul11));

  const week = evalText(["today is 8 july", "one week after today"].join("\n"));
  const jul15 = new Date(jul8);
  jul15.setDate(jul15.getDate() + 7);
  assert.equal(week[1], formatDate(jul15));

  // "before" subtracts, and non-"today" reference names work too.
  const before = evalText(["payday is 8 july", "5 days before payday"].join("\n"));
  const jul3 = new Date(jul8);
  jul3.setDate(jul3.getDate() - 5);
  assert.equal(before[1], formatDate(jul3));

  // Bare "today"/"tomorrow"/"yesterday" (no prior redefinition) resolve to
  // the real current date.
  const real = evalText("2 weeks from today");
  const twoWeeksOut = new Date();
  twoWeeksOut.setDate(twoWeeksOut.getDate() + 14);
  assert.equal(real[0], formatDate(startOfDayHelper(twoWeeksOut)));
});

function startOfDayHelper(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

test("bare assignment does not hijack recognized keywords/functions", () => {
  assert.equal(evalLine("square 3"), "9"); // "square" stays the unary function
  assert.equal(evalLine("average 10"), "10"); // "average" stays the aggregate function
  assert.equal(evalLine("what 5"), ""); // filler word, not a variable name
  // Plain notes (value part doesn't start with a number) are still left alone.
  assert.equal(evalLine("meeting notes are important"), "");
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

test("unit conversions via math.js (regression: was returning no answer)", () => {
  assert.equal(evalLine("100 cm in m"), "1 m");
  assert.equal(evalLine("100 cm to m"), "1 m"); // "to" already worked; "in" didn't
  assert.equal(evalLine("2 hours in minutes"), "120 minutes");
  assert.equal(evalLine("1 inch to cm"), "2.54 cm");
});

test("unit-valued variables can be assigned and reused", () => {
  const results = evalText("height = 180 cm\nheight in m".split("\n").join("\n"));
  assert.deepEqual(results, ["180 cm", "1.8 m"]);
});

test("currency conversion is NOT handled locally (falls through to AI fallback)", () => {
  // "dollars"/"RMB" aren't math.js units, so this must stay empty locally.
  assert.equal(evalLine("100 dollars in RMB"), "");
});

test("large numbers are formatted with thousands separators", () => {
  assert.equal(evalLine("1000000 + 1"), "1,000,001");
});

test("unit names are syntax-highlighted (regression: were plain black text)", () => {
  const html = highlightText("1 kg in lb\n1 inch in cm\nhello world", []);
  assert.match(html, /<span class="tok-unit">kg<\/span>/);
  assert.match(html, /<span class="tok-unit">lb<\/span>/);
  assert.match(html, /<span class="tok-unit">inch<\/span>/);
  assert.match(html, /<span class="tok-keyword">in<\/span>/);
  // Ordinary words that aren't math.js units stay unstyled.
  assert.doesNotMatch(html, /tok-unit">hello/);
  assert.doesNotMatch(html, /tok-unit">world/);
});

test("transformExpr and slugify helpers", () => {
  assert.equal(transformExpr("15% of 95"), "((15)/100*(95))");
  assert.equal(slugify("Daily Snack Cost"), "daily_snack_cost");
  assert.equal(slugify("2nd variable"), "_2nd_variable");
});
