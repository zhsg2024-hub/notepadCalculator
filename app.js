/**
 * Notepad Calculator
 * Type plain-English math on the right, results appear on the left.
 */

const NUM = "-?\\d+(?:\\.\\d+)?";
const OPERAND = `(?:${NUM}|[a-zA-Z_]\\w*)`;

const STORAGE_KEY = "notepad-calculator:content";

const DEFAULT_TEXT = `15% of 95
sum of 4, 23.4, 45, 67, 90

price = 120
tax = 8% of price
price + tax

average of 3, 4, 5
(10 + 5) * 2

the decimal part of 10.2
square root of 81

daily snack cost = $5
weekly snack cost = 7 * daily snack cost
`;

const inputEl = document.getElementById("input");
const resultsEl = document.getElementById("results");
const highlightEl = document.getElementById("highlight");
const clearBtn = document.getElementById("clearBtn");
const copyBtn = document.getElementById("copyBtn");

/* ---------------- Text -> math expression transforms ---------------- */

function stripFillers(text) {
  return text
    .replace(/^\s*(what\s*('?s|\s+is)|calculate|compute|how\s+much\s+is|find)\s+/i, "")
    .replace(/\?+\s*$/, "")
    .trim();
}

// Left-hand side may be a multi-word phrase, e.g. "daily snack cost = $5".
function splitAssignment(line) {
  const m = line.match(/^([a-zA-Z][a-zA-Z0-9_ ]*?)\s*=\s*(?!=)(.+)$/);
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
  "fractional|integer|whole|part|absolute|value|abs|cube|what|is|calculate|compute|how|much|find)\\b";

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

function highlightLine(line, phrases, phraseSet) {
  const tokenRe = buildTokenRegex(phrases);
  const m = line.match(/^(\s*)([a-zA-Z][a-zA-Z0-9_ ]*?)(\s*)(=)(?!=)/);
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
  return highlightTokens(line, tokenRe, phraseSet);
}

function renderHighlight(text, phrases) {
  const phraseSet = new Set(phrases.map(normalizePhrase));
  highlightEl.innerHTML = text
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

/* ---------------- AI fallback (Qwen, via local server) ---------------- */
// The rule engine above runs first and is always instant. Only lines it
// can't solve — and that plausibly contain a calculation — are sent to the
// local fallback service (server/server.js), which asks Qwen for an answer.

const FALLBACK_BASE = "http://localhost:8787";
const FALLBACK_DEBOUNCE_MS = 700;

let fallbackGeneration = 0;
let fallbackTimer = null;

// Cache AI answers keyed by "everything up to and including this line",
// so unrelated edits elsewhere in the notepad don't wipe or re-fetch them.
// A cached value of `null` means "we already asked, there's no answer".
// Persisted to localStorage so reloading the page doesn't re-spend API
// calls on lines it already solved.
const AI_CACHE_STORAGE_KEY = "notepad-calculator:ai-cache";
const AI_CACHE_MAX_ENTRIES = 500;

function loadFallbackCache() {
  try {
    const raw = localStorage.getItem(AI_CACHE_STORAGE_KEY);
    if (!raw) return new Map();
    return new Map(JSON.parse(raw));
  } catch (e) {
    return new Map();
  }
}

function saveFallbackCache() {
  try {
    localStorage.setItem(AI_CACHE_STORAGE_KEY, JSON.stringify([...fallbackCache]));
  } catch (e) {
    // Storage full or unavailable — cache just won't survive a reload.
  }
}

const fallbackCache = loadFallbackCache();

function cacheAnswer(key, value) {
  fallbackCache.set(key, value);
  // Drop the oldest entries once the cache grows too large.
  while (fallbackCache.size > AI_CACHE_MAX_ENTRIES) {
    fallbackCache.delete(fallbackCache.keys().next().value);
  }
  saveFallbackCache();
}

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

function scheduleFallback(lines, results, phrases, generation) {
  clearTimeout(fallbackTimer);
  fallbackTimer = setTimeout(() => {
    lines.forEach((raw, i) => {
      const trimmed = raw.trim();
      if (!trimmed || /^(\/\/|#)/.test(trimmed)) return;
      if (results[i] !== "") return; // rule engine already solved it
      const key = contextKey(lines, i);
      if (fallbackCache.has(key)) return; // already answered (or confirmed no-answer)
      if (!lineLooksLikeCalculation(trimmed, phrases)) return;
      runFallback(lines, i, generation, key);
    });
  }, FALLBACK_DEBOUNCE_MS);
}

function getResultCell(index) {
  return resultsEl.children[index] || null;
}

function applyCachedAnswer(cell, cached) {
  cell.classList.remove("pending", "empty", "ai", "ai-text");
  if (cached) {
    cell.textContent = cached.value;
    cell.classList.add("ai");
    if (cached.type === "text") cell.classList.add("ai-text");
    cell.title = "由 AI 兜底计算(本地规则未能解析)";
  } else {
    cell.textContent = "";
    cell.classList.add("empty");
  }
}

async function runFallback(lines, lineIndex, generation, key) {
  const pendingCell = getResultCell(lineIndex);
  if (pendingCell) {
    pendingCell.classList.remove("empty");
    pendingCell.classList.add("pending");
    pendingCell.textContent = "…";
  }

  try {
    const res = await fetch(`${FALLBACK_BASE}/api/evaluate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines, lineIndex }),
    });
    if (generation !== fallbackGeneration) return; // input changed meanwhile
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    let cached = null;
    if (data.resultType === "number" && typeof data.result === "number" && isFinite(data.result)) {
      cached = { type: "number", value: formatNumber(round(data.result)) };
    } else if (data.resultType === "text" && typeof data.result === "string" && data.result.trim()) {
      cached = { type: "text", value: data.result.trim() };
    }
    cacheAnswer(key, cached); // cached may legitimately be null ("no answer")

    const cell = getResultCell(lineIndex);
    if (cell) applyCachedAnswer(cell, cached);
  } catch (e) {
    if (generation !== fallbackGeneration) return;
    // Don't cache network/timeout failures — let it retry on the next edit.
    const cell = getResultCell(lineIndex);
    if (cell) {
      cell.classList.remove("pending");
      cell.classList.add("empty");
      cell.textContent = "";
    }
  }
}

/* ---------------- Fallback service status indicator ---------------- */

const statusEl = document.getElementById("fallbackStatus");

async function checkFallbackStatus() {
  try {
    const res = await fetch(`${FALLBACK_BASE}/api/health`, { cache: "no-store" });
    const data = await res.json();
    statusEl.textContent = data.hasKey ? "AI 兜底:在线" : "AI 兜底:缺少 Key";
    statusEl.className = "status" + (data.hasKey ? " online" : " warn");
  } catch (e) {
    statusEl.textContent = "AI 兜底:离线";
    statusEl.className = "status offline";
  }
}

/* ---------------- Rendering ---------------- */

function render() {
  fallbackGeneration += 1;
  const generation = fallbackGeneration;

  const text = inputEl.value;
  const lines = text.split("\n");
  const { results, phrases } = evaluateLines(text);

  resultsEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  results.forEach((r, i) => {
    const div = document.createElement("div");
    if (r !== "") {
      div.className = "result-line";
      div.textContent = r;
    } else {
      div.className = "result-line";
      applyCachedAnswer(div, fallbackCache.get(contextKey(lines, i)) ?? null);
    }
    frag.appendChild(div);
  });
  resultsEl.appendChild(frag);

  renderHighlight(text, phrases);

  localStorage.setItem(STORAGE_KEY, text);

  scheduleFallback(lines, results, phrases, generation);
}

/* ---------------- Wiring ---------------- */

function syncScroll(from, ...targets) {
  targets.forEach((to) => {
    to.scrollTop = from.scrollTop;
    to.scrollLeft = from.scrollLeft;
  });
}

inputEl.addEventListener("input", render);
inputEl.addEventListener("scroll", () => syncScroll(inputEl, resultsEl, highlightEl));
resultsEl.addEventListener("scroll", () => syncScroll(resultsEl, inputEl, highlightEl));

clearBtn.addEventListener("click", () => {
  inputEl.value = "";
  render();
  inputEl.focus();
});

copyBtn.addEventListener("click", async () => {
  const { results } = evaluateLines(inputEl.value);
  const text = results.join("\n");
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = "已复制!";
    setTimeout(() => (copyBtn.textContent = "复制结果"), 1200);
  } catch (e) {
    // Clipboard API unavailable — ignore silently.
  }
});

// Keep the two panes' number of visual lines identical while typing,
// tabs insert two spaces instead of moving focus away.
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const start = inputEl.selectionStart;
    const end = inputEl.selectionEnd;
    inputEl.value = inputEl.value.slice(0, start) + "  " + inputEl.value.slice(end);
    inputEl.selectionStart = inputEl.selectionEnd = start + 2;
    render();
  }
});

/* ---------------- Init ---------------- */

(function init() {
  const saved = localStorage.getItem(STORAGE_KEY);
  inputEl.value = saved !== null ? saved : DEFAULT_TEXT;
  render();
  checkFallbackStatus();
  setInterval(checkFallbackStatus, 30000);
})();
