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

/* ---------------- Date arithmetic (fully local, no AI needed) ---------------- */
// Handles things like:
//   today is 8 july
//   three days after today
//   one week after today
//   next payday is 2026-08-15
//   2 months before next payday
// This is plain calendar math, not a "smart" natural-language feature, so
// there's no reason it should ever require the AI fallback / network.

const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const WORD_TO_NUM = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12,
};

function wordToNumber(word) {
  const s = word.trim().toLowerCase();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return WORD_TO_NUM[s];
}

function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function formatDate(d) {
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${weekdays[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}

// Parses ONE self-contained date literal — "today"/"tomorrow"/"yesterday",
// "8 july" / "july 8" (year optional, defaults to this year), or an ISO
// "2026-07-08". Does not know about variables; callers check a dateScope
// map first via resolveDateRef() below.
function parseDateLiteral(text) {
  const t = text.trim().toLowerCase().replace(/,/g, "");
  if (!t) return null;

  if (t === "today") return startOfDay(new Date());
  if (t === "tomorrow") {
    const d = startOfDay(new Date());
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (t === "yesterday") {
    const d = startOfDay(new Date());
    d.setDate(d.getDate() - 1);
    return d;
  }

  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));

  // "8 july" or "8 july 2027"
  m = t.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)\s*(\d{4})?$/);
  if (m) {
    const monthIdx = MONTH_NAMES.indexOf(m[2]);
    if (monthIdx === -1) return null;
    return new Date(m[3] ? Number(m[3]) : new Date().getFullYear(), monthIdx, Number(m[1]));
  }

  // "july 8" or "july 8 2027"
  m = t.match(/^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*(\d{4})?$/);
  if (m) {
    const monthIdx = MONTH_NAMES.indexOf(m[1]);
    if (monthIdx === -1) return null;
    return new Date(m[3] ? Number(m[3]) : new Date().getFullYear(), monthIdx, Number(m[2]));
  }

  return null;
}

// A name defined via "<name> is <date>" takes priority over the literal
// meaning of that word, so re-defining "today" (like the app's own hint
// examples do) is respected by every later reference to it.
function resolveDateRef(text, dateScope) {
  const key = text.trim().toLowerCase();
  if (dateScope.has(key)) return dateScope.get(key);
  return parseDateLiteral(text);
}

const DATE_OFFSET_RE =
  /^(\d+|[a-zA-Z]+)\s+(day|days|week|weeks|month|months|year|years)\s+(after|before|from)\s+(.+)$/i;

function addToDate(date, qty, unit, sign) {
  const d = new Date(date);
  const u = unit.toLowerCase();
  if (u.startsWith("day")) d.setDate(d.getDate() + sign * qty);
  else if (u.startsWith("week")) d.setDate(d.getDate() + sign * qty * 7);
  else if (u.startsWith("month")) d.setMonth(d.getMonth() + sign * qty);
  else if (u.startsWith("year")) d.setFullYear(d.getFullYear() + sign * qty);
  return d;
}

// Tries to read a line as "<n> days/weeks/months/years after/before/from
// <ref>". Returns a formatted date string, or null if it isn't that kind of
// line at all (so the caller falls back to the normal numeric engine).
function tryDateOffset(expr, dateScope) {
  const m = expr.match(DATE_OFFSET_RE);
  if (!m) return null;
  const qty = wordToNumber(m[1]);
  if (qty === undefined) return null;
  const ref = resolveDateRef(m[4], dateScope);
  if (!ref) return null;
  const sign = m[3].toLowerCase() === "before" ? -1 : 1;
  return formatDate(addToDate(ref, qty, m[2], sign));
}

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

// Words that must never be swallowed as a bare-assignment name below, since
// they're either a real function/keyword this engine recognizes at the
// start of a line (so "square 3", "sum of 1, 2", "average 10" etc. keep
// their normal meaning) or a filler word from a question ("what is ...").
const RESERVED_LEADING_WORDS = new Set([
  "sum", "summary", "total", "add", "average", "avg", "mean", "max", "maximum", "min", "minimum",
  "the", "square", "cube", "sqrt", "root", "decimal", "fractional", "integer", "whole", "part",
  "absolute", "abs", "what", "how", "calculate", "compute", "find",
  "is", "equals", "of", "up", "below", "percent", "plus", "minus", "times",
  "multiplied", "divided", "by", "over", "in", "to",
]);

// Bare, verb-less "<name> <value>" assignment, e.g. "discount 10% of price"
// or "price 100" (shorthand for "discount is 10% of price" / "price is
// 100"). Deliberately narrower than the "is"/"equals"/"=" forms: only a
// single-word name (multi-word phrases still need an explicit "is"/"="),
// and only when the rest of the line visibly starts with a value (a number
// or currency symbol) rather than more words — so plain notes like
// "meeting notes are important" are never misread as an assignment.
const BARE_ASSIGN_RE = /^([a-zA-Z][a-zA-Z0-9_]*)(\s+)(?=[$¥£€]?-?\d)(.+)$/;

function trySplitBareAssignment(line) {
  const m = line.match(BARE_ASSIGN_RE);
  if (!m) return null;
  const [, name, spacing, expr] = m;
  if (RESERVED_LEADING_WORDS.has(name.toLowerCase())) return null;
  return { name, spacing, expr };
}

// Left-hand side may be a multi-word phrase, e.g. "daily snack cost = $5"
// or "daily snack cost is $5".
function splitAssignment(line) {
  let m = line.match(/^([a-zA-Z][a-zA-Z0-9_ ]*?)\s*=\s*(?!=)(.+)$/);
  if (m) return { name: m[1].trim(), expr: m[2] };

  m = line.match(ASSIGN_IS_RE);
  if (m) return { name: m[1].trim(), expr: m[2] };

  const bare = trySplitBareAssignment(line);
  if (bare) return { name: bare.name, expr: bare.expr };

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

// Each comma-separated item can be a literal number OR anything math.js can
// evaluate against the current scope — most usefully, a variable defined on
// an earlier line (e.g. "sum of tax, price"). Falls back to null (letting
// the line fail/go to AI fallback) if any item can't be resolved at all,
// rather than silently ignoring it.
function resolveAggregateItems(text, scope) {
  const parts = text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;

  const exactNumberRe = new RegExp(`^${NUM}$`);
  const nums = [];
  for (const part of parts) {
    if (exactNumberRe.test(part)) {
      nums.push(Number(part));
      continue;
    }
    try {
      const v = math.evaluate(part, scope || {});
      if (typeof v !== "number" || Number.isNaN(v) || !isFinite(v)) return null;
      nums.push(v);
    } catch (e) {
      return null;
    }
  }
  return nums;
}

function tryAggregate(expr, scope) {
  const re = /^(?:the\s+)?(sum|summary|total|add(?:\s+up)?|average|avg|mean|max(?:imum)?|min(?:imum)?)\s+(?:of|up|:)?\s*(?:below[:]?)?\s*(.+)$/i;
  const m = expr.match(re);
  if (!m) return null;

  const kind = m[1].toLowerCase();
  const nums = resolveAggregateItems(m[2], scope);
  if (!nums || nums.length === 0) return null;

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
  // "square root of", "sqrt of" and the bare "root of" (plus the "of"-less
  // shorthand, e.g. "root 9") all mean the same thing.
  { re: /^(?:the\s+)?(?:square\s+root|sqrt|root)\s+(?:of\s+)?(.+)$/i, wrap: (x) => `sqrt(${x})` },
  { re: /^(?:the\s+)?(?:absolute\s+value|abs)\s+of\s+(.+)$/i, wrap: (x) => `abs(${x})` },
  // "of" is optional, so both "square of 3" and the shorter "square 3" work.
  { re: /^(?:the\s+)?square\s+(?:of\s+)?(.+)$/i, wrap: (x) => `(${x})^2` },
  { re: /^(?:the\s+)?cube\s+(?:of\s+)?(.+)$/i, wrap: (x) => `(${x})^3` },
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

function transformExpr(expr, scope) {
  let e = stripFillers(expr);

  const agg = tryAggregate(e, scope);
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
  "fractional|integer|whole|part|absolute|value|abs|cube|what|is|equals|calculate|compute|how|much|find|" +
  "in|to|today|tomorrow|yesterday|after|before|from)\\b";

const CURRENCY_NUM = `[$¥£€]?${NUM}`;

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Recognizes unit names understood by math.js's unit-conversion system
// (e.g. "cm", "kg", "inches", "minutes" in "100 cm in m", "5 kg to lb"),
// so they can be colored consistently instead of falling back to plain text.
function isUnitWord(word) {
  try {
    return math.Unit.isValuelessUnit(word);
  } catch (e) {
    return false;
  }
}

// Builds a tokenizer regex that also recognizes previously-defined
// multi-word variable phrases so they can be colored consistently. The
// trailing bare-word group catches anything else made of letters (e.g.
// candidate unit names) so callers can classify it themselves.
function buildTokenRegex(phrases) {
  const phrasePattern = phrases.length
    ? `\\b(?:${phrases
        .slice()
        .sort((a, b) => b.length - a.length)
        .map((p) => p.trim().split(/\s+/).map(escapeRegex).join("\\s+"))
        .join("|")})\\b|`
    : "";
  return new RegExp(
    `(\\/\\/.*|#.*)|(${phrasePattern}${KEYWORD_RE})|(${CURRENCY_NUM})|([+\\-*/^%=()])|([a-zA-Z]+)`,
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
    const [full, comment, keyword, number, operator, word] = m;
    if (comment) result += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
    else if (keyword) {
      const cls = phraseSet.has(normalizePhrase(keyword)) ? "tok-variable" : "tok-keyword";
      result += `<span class="${cls}">${escapeHtml(keyword)}</span>`;
    } else if (number) result += `<span class="tok-number">${escapeHtml(number)}</span>`;
    else if (operator) result += `<span class="tok-operator">${escapeHtml(operator)}</span>`;
    else if (word) {
      result += isUnitWord(word)
        ? `<span class="tok-unit">${escapeHtml(word)}</span>`
        : escapeHtml(word);
    }
    lastIndex = m.index + full.length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}

const ASSIGN_IS_HL_RE = new RegExp(
  `^(\\s*)${ASSIGN_IS_GUARD}([a-zA-Z][a-zA-Z0-9_ ]*?)(\\s+)(is|equals)(\\s+)`,
  "i"
);

const BARE_ASSIGN_HL_RE = /^(\s*)([a-zA-Z][a-zA-Z0-9_]*)(\s+)(?=[$¥£€]?-?\d)/;

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

  m = line.match(BARE_ASSIGN_HL_RE);
  if (m && !RESERVED_LEADING_WORDS.has(m[2].toLowerCase())) {
    const [full, lead, name, spacing] = m;
    const rest = line.slice(full.length);
    return (
      escapeHtml(lead) +
      `<span class="tok-variable">${escapeHtml(name)}</span>` +
      escapeHtml(spacing) +
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
  const dateScope = new Map(); // lowercased name -> Date, e.g. "today" -> Date
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

    // Date arithmetic is handled entirely locally — no AI/network needed —
    // either "<name> is <date>" (defines/redefines what a name means) or a
    // bare "<n> days/weeks/months/years after/before/from <ref>" line.
    if (name) {
      const dateLiteral = parseDateLiteral(rawExpr);
      if (dateLiteral) {
        dateScope.set(name.trim().toLowerCase(), dateLiteral);
        return formatDate(dateLiteral);
      }
    } else {
      const dateResult = tryDateOffset(trimmed, dateScope);
      if (dateResult) return dateResult;
    }

    let expr = stripCurrency(rawExpr);
    expr = substituteKnownPhrases(expr);
    const transformed = transformExpr(expr, scope);
    if (!transformed) return "";

    const slug = name ? slugify(name) : null;

    try {
      const fullExpr = slug ? `${slug} = ${transformed}` : transformed;
      const value = math.evaluate(fullExpr, scope);

      // Unit conversions ("100 cm in m", "5 kg to lb", ...) are handled by
      // math.js itself — "in"/"to" both work — but the result is a Unit
      // object rather than a plain number, so it needs its own formatting.
      let display = null;
      if (typeof value === "number" && !isNaN(value) && isFinite(value)) {
        display = formatNumber(round(value));
      } else if (math.isUnit(value)) {
        display = value.format(6);
      }
      if (display === null) return "";

      if (name && slug && !phraseMap.has(normalizePhrase(name))) {
        phraseMap.set(normalizePhrase(name), slug);
        phraseOrder.push(name);
      }
      return display;
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
    parseDateLiteral,
    resolveDateRef,
    formatDate,
    tryDateOffset,
    wordToNumber,
    stripFillers,
    splitAssignment,
    trySplitBareAssignment,
    extractNumbers,
    slugify,
    escapeRegex,
    phraseToRegex,
    stripCurrency,
    applyPercentOf,
    applyBarePercent,
    tryAggregate,
    resolveAggregateItems,
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
