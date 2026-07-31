/**
 * Notepad Calculator — DOM wiring
 * Type plain-English math on the right, results appear on the left.
 *
 * The actual parsing/calculation/highlighting logic lives in engine.js
 * (loaded before this file); this file only wires it up to the page.
 */

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

100 cm in m
5 kg in lb
`;

const inputEl = document.getElementById("input");
const resultsEl = document.getElementById("results");
const highlightEl = document.getElementById("highlight");
const clearBtn = document.getElementById("clearBtn");
const copyBtn = document.getElementById("copyBtn");
const statusEl = document.getElementById("fallbackStatus");
const aiToggleEl = document.getElementById("aiToggle");
const resultsRowHighlightEl = document.getElementById("resultsRowHighlight");
const inputRowHighlightEl = document.getElementById("inputRowHighlight");

function renderHighlight(text, phrases) {
  highlightEl.innerHTML = highlightText(text, phrases);
}

/* ---------------- AI fallback (Qwen, via local server) ---------------- */
// The rule engine above runs first and is always instant. Only lines it
// can't solve — and that plausibly contain a calculation — are sent to a
// fallback service, which asks Qwen for an answer.
//
// In production (e.g. deployed on Vercel), that service is the sibling
// serverless functions under /api/ — same origin, so a relative path works.
// In local dev, the frontend is usually served separately (e.g. a plain
// `python -m http.server`) from the Express server in server/server.js on
// its own port, so localhost keeps pointing there explicitly.
const FALLBACK_BASE =
  location.hostname === "localhost" || location.hostname === "127.0.0.1" ? "http://localhost:8787" : "";
const FALLBACK_DEBOUNCE_MS = 700;

// Master switch: when off (the default), the app is 100% offline — it never
// calls /api/health or /api/evaluate, and never shows previously-cached AI
// answers either, so behavior is fully predictable regardless of whether a
// backend happens to be running on localhost:8787.
const AI_ENABLED_STORAGE_KEY = "notepad-calculator:ai-enabled";

function loadAiEnabled() {
  try {
    return localStorage.getItem(AI_ENABLED_STORAGE_KEY) === "true";
  } catch (e) {
    return false;
  }
}

function saveAiEnabled(value) {
  try {
    localStorage.setItem(AI_ENABLED_STORAGE_KEY, value ? "true" : "false");
  } catch (e) {
    // Storage unavailable — the toggle just won't persist across reloads.
  }
}

let aiEnabled = loadAiEnabled();

let fallbackGeneration = 0;
let fallbackTimer = null;

// Cache AI answers keyed by "everything up to and including this line" (see
// contextKey() in engine.js), so unrelated edits elsewhere in the notepad
// don't wipe or re-fetch them. A cached value of `null` means "we already
// asked, there's no answer". Persisted to localStorage so reloading the page
// doesn't re-spend API calls on lines it already solved.
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

function scheduleFallback(lines, results, phrases, generation) {
  clearTimeout(fallbackTimer);
  if (!aiEnabled) return; // 100% offline mode — never schedule a network call
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
    cell.title = "Computed by AI fallback (local rules couldn't parse this)";
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

async function checkFallbackStatus() {
  if (!aiEnabled) {
    statusEl.textContent = "AI fallback: off";
    statusEl.className = "status disabled";
    return; // never touch the network while disabled
  }
  try {
    const res = await fetch(`${FALLBACK_BASE}/api/health`, { cache: "no-store" });
    const data = await res.json();
    statusEl.textContent = data.hasKey ? "AI fallback: online" : "AI fallback: missing key";
    statusEl.className = "status" + (data.hasKey ? " online" : " warn");
  } catch (e) {
    statusEl.textContent = "AI fallback: offline";
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
    div.className = "result-line";
    if (r !== "") {
      div.textContent = r;
    } else if (aiEnabled) {
      applyCachedAnswer(div, fallbackCache.get(contextKey(lines, i)) ?? null);
    } else {
      div.classList.add("empty"); // offline mode — don't surface cached AI answers either
    }
    frag.appendChild(div);
  });
  resultsEl.appendChild(frag);
  renderHighlight(text, phrases);

  // Rebuilding resultsEl's/highlightEl's content above can leave their
  // scrollTop stale relative to inputEl (e.g. the browser auto-scrolls the
  // textarea to keep the caret in view while typing, which fires its own
  // 'scroll' event asynchronously — by the time that catches up, this
  // render() has already redrawn the other two panes at their old
  // position). Re-assert inputEl as the source of truth on every render so
  // they can never drift apart while editing.
  resultsEl.scrollTop = inputEl.scrollTop;
  resultsEl.scrollLeft = inputEl.scrollLeft;
  highlightEl.scrollTop = inputEl.scrollTop;
  highlightEl.scrollLeft = inputEl.scrollLeft;

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

// Keep the two panes mirrored while actively scrolling. A plain 'scroll'
// event listener alone lags behind real trackpad/inertial scrolling on
// macOS — the pane you're touching is scrolled smoothly by the OS/browser
// compositor, while the mirrored pane only catches up whenever the (throttled)
// 'scroll' event fires, which visibly drifts out of alignment mid-gesture.
// Polling every animation frame from whichever pane was scrolled most
// recently keeps them locked together with no perceptible lag.
//
// IMPORTANT: the "driver" must be picked from genuine user-input signals
// (wheel/touch/pointer), NOT from 'scroll' events. Writing scrollTop into
// the mirrored pane below also fires a 'scroll' event on it — if that were
// allowed to flip the driver, the two panes ping-pong "drive" each other
// every frame. Any sub-pixel rounding difference between their scrollHeight
// (from font rendering) then gets fed back and re-amplified on each bounce,
// and over a fast/long scroll gesture this compounds into a full visible
// row of drift that never self-corrects — exactly the "answers are one row
// off from their questions" symptom.
let scrollDriver = null; // resultsEl | inputEl | null

function markDriver(el) {
  return () => {
    scrollDriver = el;
  };
}
resultsEl.addEventListener("wheel", markDriver(resultsEl), { passive: true });
resultsEl.addEventListener("touchstart", markDriver(resultsEl), { passive: true });
resultsEl.addEventListener("mousedown", markDriver(resultsEl));
inputEl.addEventListener("wheel", markDriver(inputEl), { passive: true });
inputEl.addEventListener("touchstart", markDriver(inputEl), { passive: true });
inputEl.addEventListener("mousedown", markDriver(inputEl));

function scrollSyncLoop() {
  if (scrollDriver === resultsEl) {
    syncScroll(resultsEl, inputEl, highlightEl);
  } else if (scrollDriver === inputEl) {
    syncScroll(inputEl, resultsEl, highlightEl);
  }
  requestAnimationFrame(scrollSyncLoop);
}
requestAnimationFrame(scrollSyncLoop);

/* ---------------- Row highlight (hover) ---------------- */
// A soft band that follows whichever line the mouse is over, mirrored in
// both panes at once, so it's obvious at a glance which answer belongs to
// which question — especially handy once you've scrolled.
const LINE_HEIGHT = 28;
const PANE_PADDING_TOP = 4;

function showRowHighlightAt(clientY, containerEl) {
  const rect = containerEl.getBoundingClientRect();
  const relY = clientY - rect.top + containerEl.scrollTop - PANE_PADDING_TOP;
  const lineIndex = Math.max(0, Math.floor(relY / LINE_HEIGHT));
  const top = PANE_PADDING_TOP + lineIndex * LINE_HEIGHT - containerEl.scrollTop;
  resultsRowHighlightEl.style.top = `${top}px`;
  inputRowHighlightEl.style.top = `${top}px`;
  resultsRowHighlightEl.classList.add("visible");
  inputRowHighlightEl.classList.add("visible");
}

function hideRowHighlight() {
  resultsRowHighlightEl.classList.remove("visible");
  inputRowHighlightEl.classList.remove("visible");
}

resultsEl.addEventListener("mousemove", (e) => showRowHighlightAt(e.clientY, resultsEl));
resultsEl.addEventListener("mouseleave", hideRowHighlight);
resultsEl.addEventListener("scroll", hideRowHighlight);
inputEl.addEventListener("mousemove", (e) => showRowHighlightAt(e.clientY, inputEl));
inputEl.addEventListener("mouseleave", hideRowHighlight);
inputEl.addEventListener("scroll", hideRowHighlight);

inputEl.addEventListener("input", render);

aiToggleEl.addEventListener("change", () => {
  aiEnabled = aiToggleEl.checked;
  saveAiEnabled(aiEnabled);
  fallbackGeneration += 1; // invalidate any in-flight request from before the switch
  clearTimeout(fallbackTimer);
  checkFallbackStatus();
  render();
});

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
    copyBtn.textContent = "Copied!";
    setTimeout(() => (copyBtn.textContent = "Copy results"), 1200);
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
  aiToggleEl.checked = aiEnabled;
  const saved = localStorage.getItem(STORAGE_KEY);
  inputEl.value = saved !== null ? saved : DEFAULT_TEXT;
  render();
  checkFallbackStatus();
  setInterval(checkFallbackStatus, 30000);
})();
