/**
 * Notepad Calculator — core engine
 *
 * Pure parsing/calculation/highlighting logic, with no DOM dependency, so it
 * can be loaded both as a plain <script> in the browser (see index.html) and
 * with require() from Node test files (see tests/engine.test.js).
 *
 * Depends on the global `math` object (from math.js) being available, either
 * via the CDN <script> tag in index.html, or via `global.math = require("mathjs")`
 * in Node.
 */

const NUM = "-?\\d+(?:\\.\\d+)?";
const OPERAND = `(?:${NUM}|[a-zA-Z_]\\w*)`;

/* ---------------- Text -> math expression transforms ---------------- */

function stripFillers(text) {
  return text
    .replace(/^\s*(what\s*('?s|\s+is)|calculate|compute|how\s+much\s+is|find)\s+/i, "")
    .replace(/\?+\s*$/, "")
    .trim();
}

// Guards the natural-language "name is/equals value" assignment form (below)
// from misfiring on question phrasing like "what is 5+5" / "how much is 5+5".
const ASSIGN_IS_GUARD = "(?!what\\b|how\\s+(?:much|many)\\b)";

// Natural-language assignment: "<name> is|equals <value>", e.g.
// "daily transport fee is 7". Shared between splitAssignment() and
// highlightLine() so the two stay in sync.
const ASSIGN_IS_RE = new RegExp(
  `^${ASSIGN_IS_GUARD}([a-zA-Z][a-zA-Z0-9_ ]*?)\\s+(?:is|equals)\\s+(.+)$`,
  "i"
);

// Left-hand side may be a multi-word phrase, e.g. "daily snack cost = $5"
// or "daily snack cost is $5".
function splitAssignment(line) {
  let m = line.match(/^([a-zA-Z][a-zA-Z0-9_ ]*?)\s*=\s*(?!=)(.+)$/);
  if (m) return { name: m[1].trim(), expr: m[2] };

  m = line.match(ASSIGN_IS_RE);
  if (m) return { name: m[1].trim(), expr: m[2] };

  return { name: null, expr: line };
}

function extractNumbers(text) {
  const matches = text.match(new RegExp(NUM, "g"));
  return matches ? matches.map(Number) : [];
}

// Turns a natural-language phrase into a valid math.js identifier,
// e.g. "Daily Snack Cost" -> "daily_snack_cost".
function slugify(phrase) {
  const s = phrase
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[0-9]/.test(s) ? `_${s}` : s || "_v";
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Matches a phrase allowing flexible whitespace between its words,
// e.g. phrase "daily snack cost" also matches "daily  snack cost".
function phraseToRegex(phrase) {
  const words = phrase.trim().split(/\s+/).map(escapeRegex);
  return new RegExp(`\\b${words.join("\\s+")}\\b`, "gi");
}

// Strip currency symbols glued to a number, e.g. "$5" -> "5".
function stripCurrency(expr) {
  return expr.replace(/[$¥£€]\s*(?=\d)/g, "");
}

function applyPercentOf(expr) {
  const re = new RegExp(`(${OPERAND})\\s*(?:%|percent)\\s*of\\s*(${OPERAND})`, "gi");
  return expr.replace(re, (_, a, b) => `((${a})/100*(${b}))`);
}

function applyBarePercent(expr) {
  // "20%" on its own (not already consumed by "X% of Y") -> (20/100)
  return expr.replace(new RegExp(`(${NUM})\\s*%`, "g"), "($1/100)");
}

function tryAggregate(expr) {
  const re = /^(?:the\s+)?(sum|summary|total|add(?:\s+up)?|average|avg|mean|max(?:imum)?|min(?:imum)?)\s+(?:of|up|:)?\s*(?:below[:]?)?\s*(.+)$/i;
  const m = expr.match(re);
  if (!m) return null;

  const kind = m[1].toLowerCase();
  const nums = extractNumbers(m[2]);
  if (nums.length === 0) return null;

  const total = nums.reduce((a, b) => a + b, 0);
  if (/^(sum|summary|total|add)/.test(kind)) return String(total);
  if (/^(average|avg|mean)/.test(kind)) return String(total / nums.length);
  if (/^max/.test(kind)) return String(Math.max(...nums));
  if (/^min/.test(kind)) return String(Math.min(...nums));
  return null;
}

function replaceWordOperators(expr) {
  return expr
    .replace(/\bmultiplied\s+by\b/gi, "*")
    .replace(/\bdivided\s+by\b/gi, "/")
    .replace(/\bplus\b/gi, "+")
    .replace(/\bminus\b/gi, "-")
    .replace(/\btimes\b/gi, "*")
    .replace(/\bover\b/gi, "/");
}

// Whole-line "<phrase> of <argument>" style unary functions, e.g.
// "the decimal part of 10.2" or "square root of 81".
const UNARY_PHRASES = [
  { re: /^(?:the\s+)?(?:decimal|fractional)\s+part\s+of\s+(.+)$/i, wrap: (x) => `((${x})-fix(${x}))` },
  { re: /^(?:the\s+)?(?:integer|whole)\s+part\s+of\s+(.+)$/i, wrap: (x) => `fix(${x})` },
  { re: /^(?:the\s+)?(?:square\s+root|sqrt)\s+of\s+(.+)$/i, wrap: (x) => `sqrt(${x})` },
  { re: /^(?:the\s+)?(?:absolute\s+value|abs)\s+of\s+(.+)$/i, wrap: (x) => `abs(${x})` },
  { re: /^(?:the\s+)?square\s+of\s+(.+)$/i, wrap: (x) => `(${x})^2` },
  { re: /^(?:the\s+)?cube\s+of\s+(.+)$/i, wrap: (x) => `(${x})^3` },
];

function tryUnaryPhrase(expr) {
  for (const { re, wrap } of UNARY_PHRASES) {
    const m = expr.match(re);
    if (m) {
      const inner = applyBarePercent(applyPercentOf(replaceWordOperators(m[1])));
      return wrap(inner);
    }
  }
  return null;
}

function transformExpr(expr) {
  let e = stripFillers(expr);

  const agg = tryAggregate(e);
  if (agg !== null) return agg;

  const unary = tryUnaryPhrase(e);
  if (unary !== null) return unary;

  e = applyPercentOf(e);
  e = replaceWordOperators(e);
  e = applyBarePercent(e);
  return e;
}

function round(v) {
  return Math.round(v * 1e8) / 1e8;
}

function formatNumber(v) {
  if (!isFinite(v)) return "";
  if (Number.isInteger(v)) return v.toLocaleString("en-US");
  return v.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

/* ---------------- Syntax highlighting ---------------- */

const KEYWORD_RE =
  "\\b(?:sum|summary|total|add|average|avg|mean|max|maximum|min|minimum|of|up|below|" +
  "percent|plus|minus|times|multiplied|divided|by|over|the|square|root|sqrt|decimal|" +
  "fractional|integer|whole|part|absolute|value|abs|cube|what|is|equals|calculate|compute|how|much|find)\\b";

const CURRENCY_NUM = `[$¥£€]?${NUM}`;

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Builds a tokenizer regex that also recognizes previously-defined
// multi-word variable phrases so they can be colored consistently.
function buildTokenRegex(phrases) {
  const phrasePattern = phrases.length
    ? `\\b(?:${phrases
        .slice()
        .sort((a, b) => b.length - a.length)
        .map((p) => p.trim().split(/\s+/).map(escapeRegex).join("\\s+"))
        .join("|")})\\b|`
    : "";
  return new RegExp(
    `(\\/\\/.*|#.*)|(${phrasePattern}${KEYWORD_RE})|(${CURRENCY_NUM})|([+\\-*/^%=()])`,
    "gi"
  );
}

function normalizePhrase(text) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function highlightTokens(text, tokenRe, phraseSet) {
  let result = "";
  let lastIndex = 0;
  tokenRe.lastIndex = 0;
  let m;
  while ((m = tokenRe.exec(text))) {
    result += escapeHtml(text.slice(lastIndex, m.index));
    const [full, comment, keyword, number, operator] = m;
    if (comment) result += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
    else if (keyword) {
      const cls = phraseSet.has(normalizePhrase(keyword)) ? "tok-variable" : "tok-keyword";
      result += `<span class="${cls}">${escapeHtml(keyword)}</span>`;
    } else if (number) result += `<span class="tok-number">${escapeHtml(number)}</span>`;
    else if (operator) result += `<span class="tok-operator">${escapeHtml(operator)}</span>`;
    lastIndex = m.index + full.length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}

const ASSIGN_IS_HL_RE = new RegExp(
  `^(\\s*)${ASSIGN_IS_GUARD}([a-zA-Z][a-zA-Z0-9_ ]*?)(\\s+)(is|equals)(\\s+)`,
  "i"
);

function highlightLine(line, phrases, phraseSet) {
  const tokenRe = buildTokenRegex(phrases);

  let m = line.match(/^(\s*)([a-zA-Z][a-zA-Z0-9_ ]*?)(\s*)(=)(?!=)/);
  if (m) {
    const [full, lead, name, spacing] = m;
    const rest = line.slice(full.length);
    return (
      escapeHtml(lead) +
      `<span class="tok-variable">${escapeHtml(name)}</span>` +
      escapeHtml(spacing) +
      `<span class="tok-operator">=</span>` +
      highlightTokens(rest, tokenRe, phraseSet)
    );
  }

  m = line.match(ASSIGN_IS_HL_RE);
  if (m) {
    const [full, lead, name, spacing1, keyword, spacing2] = m;
    const rest = line.slice(full.length);
    return (
      escapeHtml(lead) +
      `<span class="tok-variable">${escapeHtml(name)}</span>` +
      escapeHtml(spacing1) +
      `<span class="tok-keyword">${escapeHtml(keyword)}</span>` +
      escapeHtml(spacing2) +
      highlightTokens(rest, tokenRe, phraseSet)
    );
  }

  return highlightTokens(line, tokenRe, phraseSet);
}

function highlightText(text, phrases) {
  const phraseSet = new Set(phrases.map(normalizePhrase));
  return text
    .split("\n")
    .map((line) => highlightLine(line, phrases, phraseSet))
    .join("\n");
}

/* ---------------- Line-by-line evaluation ---------------- */

function evaluateLines(text) {
  const lines = text.split("\n");
  const scope = {};
  const phraseMap = new Map(); // normalized phrase -> slug identifier
  const phraseOrder = []; // original phrase text, insertion order

  function substituteKnownPhrases(expr) {
    if (phraseOrder.length === 0) return expr;
    let result = expr;
    // Longest phrase first avoids partial overlaps ("daily snack cost" vs "cost").
    const sorted = [...phraseOrder].sort((a, b) => b.length - a.length);
    for (const phrase of sorted) {
      const slug = phraseMap.get(normalizePhrase(phrase));
      result = result.replace(phraseToRegex(phrase), slug);
    }
    return result;
  }

  const results = lines.map((raw) => {
    const trimmed = raw.trim();
    if (!trimmed || /^(\/\/|#)/.test(trimmed)) return "";

    const { name, expr: rawExpr } = splitAssignment(trimmed);
    let expr = stripCurrency(rawExpr);
    expr = substituteKnownPhrases(expr);
    const transformed = transformExpr(expr);
    if (!transformed) return "";

    const slug = name ? slugify(name) : null;

    try {
      const fullExpr = slug ? `${slug} = ${transformed}` : transformed;
      const value = math.evaluate(fullExpr, scope);
      if (typeof value !== "number" || isNaN(value) || !isFinite(value)) return "";
      if (name && slug && !phraseMap.has(normalizePhrase(name))) {
        phraseMap.set(normalizePhrase(name), slug);
        phraseOrder.push(name);
      }
      return formatNumber(round(value));
    } catch (e) {
      return "";
    }
  });

  return { results, phrases: phraseOrder };
}

/* ---------------- AI-fallback helpers (pure parts only) ---------------- */

// Cache key: "everything up to and including this line", so unrelated edits
// elsewhere in the notepad don't invalidate an already-answered line.
function contextKey(lines, index) {
  return JSON.stringify(lines.slice(0, index + 1));
}

// Words that signal "this line is probably a calculation" even without a
// digit in sight, e.g. "three weeks from today" or "next Monday".
const CALCULATION_SIGNAL_RE = new RegExp(
  "\\b(?:" +
    "today|tomorrow|yesterday|tonight|noon|midnight|now|ago|next|last|" +
    "week|weeks|month|months|year|years|day|days|hour|hours|minute|minutes|second|seconds|" +
    "am|pm|o'?clock|" +
    "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|dozen|half|double|triple|" +
    "quarter|percent|total|sum|average|plus|minus|times|divided|sqrt|square|cube" +
    ")\\b",
  "i"
);

function lineLooksLikeCalculation(line, phrases) {
  if (/\d/.test(line)) return true;
  if (CALCULATION_SIGNAL_RE.test(line)) return true;
  const lower = line.toLowerCase();
  return phrases.some((p) => lower.includes(p.toLowerCase()));
}

// Works as a plain <script> in the browser (globals) and via require() in Node.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    NUM,
    OPERAND,
    stripFillers,
    splitAssignment,
    extractNumbers,
    slugify,
    escapeRegex,
    phraseToRegex,
    stripCurrency,
    applyPercentOf,
    applyBarePercent,
    tryAggregate,
    replaceWordOperators,
    tryUnaryPhrase,
    transformExpr,
    round,
    formatNumber,
    escapeHtml,
    buildTokenRegex,
    normalizePhrase,
    highlightTokens,
    highlightLine,
    highlightText,
    evaluateLines,
    contextKey,
    lineLooksLikeCalculation,
  };
}
