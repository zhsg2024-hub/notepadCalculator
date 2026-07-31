/**
 * Tests for server/server.js's response-parsing logic. No network calls and
 * no API key needed — requiring server.js here does NOT start the HTTP
 * server (see the require.main guard at the bottom of server.js).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { extractResult } = require(path.join("..", "server", "server.js"));

test("parses a numeric JSON result", () => {
  assert.deepEqual(extractResult('{"result": 7}'), { type: "number", value: 7 });
});

test("parses a numeric JSON result wrapped in prose/markdown fences", () => {
  assert.deepEqual(
    extractResult('Sure, here you go:\n```json\n{"result": 60}\n```'),
    { type: "number", value: 60 }
  );
});

test("parses a text (date/currency) JSON result", () => {
  assert.deepEqual(extractResult('{"result": "19 Aug 2026"}'), { type: "text", value: "19 Aug 2026" });
  assert.deepEqual(extractResult('{"result": "¥677.13"}'), { type: "text", value: "¥677.13" });
});

test("null / missing result never becomes 0 (regression)", () => {
  assert.equal(extractResult('{"result": null}'), null);
  assert.equal(extractResult("{}"), null);
  assert.equal(extractResult('{"result": ""}'), null);
});

test("falls back to scraping a bare number when JSON parsing fails", () => {
  assert.deepEqual(extractResult("The answer is 42."), { type: "number", value: 42 });
});

test("returns null for completely unparseable/empty content", () => {
  assert.equal(extractResult(""), null);
  assert.equal(extractResult("no numbers or json here"), null);
});
