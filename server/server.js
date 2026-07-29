require("dotenv").config();
const express = require("express");
const cors = require("cors");

const PORT = process.env.PORT || 8787;
const QWEN_API_KEY = process.env.QWEN_API_KEY;
const QWEN_MODEL = process.env.QWEN_MODEL || "qwen-turbo";
const DASHSCOPE_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";

if (!QWEN_API_KEY) {
  console.warn("⚠️  QWEN_API_KEY is not set. Copy .env.example to .env and fill in your key.");
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, model: QWEN_MODEL, hasKey: !!QWEN_API_KEY });
});

// ---- Ground-truth context: real date + real exchange rates ----
// The model has no clock and no live market data, so we fetch/compute these
// ourselves and hand them to it as facts, instead of letting it guess.

const RATE_CURRENCIES = ["USD", "CNY", "EUR", "GBP", "JPY", "HKD", "KRW", "AUD", "CAD", "SGD", "INR"];
const RATE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let rateCache = { at: 0, rates: null };

async function getExchangeRates() {
  if (rateCache.rates && Date.now() - rateCache.at < RATE_CACHE_TTL_MS) {
    return rateCache.rates;
  }
  try {
    const to = RATE_CURRENCIES.filter((c) => c !== "USD").join(",");
    const r = await fetch(`https://api.frankfurter.app/latest?from=USD&to=${to}`);
    if (!r.ok) throw new Error(`rates HTTP ${r.status}`);
    const data = await r.json();
    const rates = { USD: 1, ...data.rates };
    rateCache = { at: Date.now(), rates };
    return rates;
  } catch (e) {
    console.warn("Exchange rate fetch failed, proceeding without rates:", e.message);
    return rateCache.rates; // may be null, or a stale-but-usable cache
  }
}

function formatToday() {
  return new Date().toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function buildPrompt(lines, targetIndex, { today, rates }) {
  const numbered = lines.map((l, i) => `${i + 1}: ${l || "(blank)"}`).join("\n");
  const ratesLine = rates
    ? RATE_CURRENCIES.map((c) => `1 USD = ${rates[c]} ${c}`).join(", ")
    : "(unavailable — do not guess currency conversions, return null instead)";

  return [
    "You are the calculation engine inside a notepad calculator app.",
    "Each line below mixes plain English with numbers, dates or times. Some lines",
    'define variables or context (e.g. "name = expression", or "today is 29 Jul");',
    "later lines may reference those names or that context.",
    "",
    `Real current date (use this for "today"/"now"/"tomorrow" unless the notepad`,
    `itself defines a different date for "today"): ${today}`,
    `Real approximate exchange rates (use for any currency conversion; derive`,
    `cross rates between two non-USD currencies by dividing their USD rates):`,
    ratesLine,
    "",
    "Work out the value of the TARGET line, using variables/context defined on",
    "earlier lines where relevant. Ignore descriptive words that carry no meaning",
    "(e.g. filler words, typos like 'dollors' for 'dollars'). Handle date/time",
    "arithmetic and currency conversion as well as plain math.",
    "",
    "Be conservative: only return an answer if the target line clearly expresses a",
    "calculation, a question with a definite answer, or a value derived from",
    "earlier lines. If the line is just a plain note, label, heading, statement of",
    "context with nothing to solve, or asks to convert a currency that isn't in",
    "the rates list above, return null — do NOT invent an answer.",
    "",
    "Respond with ONLY compact JSON, no markdown fences, no explanation:",
    '{"result": <number>}       for a numeric answer, e.g. {"result": 7}',
    '{"result": "<short text>"} for a date/time/currency/other short textual',
    '                            answer, e.g. {"result": "19 Aug 2026"} or',
    '                            {"result": "¥716.13"}',
    '{"result": null}           if the line has no computable answer',
    "",
    "Examples:",
    'Line "just some notes about today" -> {"result": null}',
    'Line "TODO: buy groceries" -> {"result": null}',
    'Line "3 apples + 4 apples" -> {"result": 7}',
    'Line "increase 50 by 20%" -> {"result": 60}',
    'Line "three weeks from today" -> {"result": "19 Aug 2026"}',
    'Line "100 dollars in RMB" -> {"result": "¥677.13"} (using the rate above)',
    "",
    "Notepad:",
    numbered,
    "",
    `Target line: ${targetIndex + 1}`,
  ].join("\n");
}

// Returns { type: "number"|"text", value } or null.
function extractResult(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*?\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      const raw = parsed.result;
      if (raw === null || raw === undefined || raw === "") return null;
      if (typeof raw === "number" && Number.isFinite(raw)) return { type: "number", value: raw };
      const asString = String(raw).trim();
      const asNumber = Number(asString);
      if (asString !== "" && Number.isFinite(asNumber) && /^-?\d+(\.\d+)?$/.test(asString)) {
        return { type: "number", value: asNumber };
      }
      return asString ? { type: "text", value: asString } : null;
    } catch (e) {
      // fall through to numeric scrape below
    }
  }
  const numMatch = text.match(/-?\d+(?:\.\d+)?/);
  return numMatch ? { type: "number", value: Number(numMatch[0]) } : null;
}

app.post("/api/evaluate", async (req, res) => {
  const { lines, lineIndex } = req.body || {};
  if (!Array.isArray(lines) || typeof lineIndex !== "number") {
    return res.status(400).json({ error: "Expected { lines: string[], lineIndex: number }" });
  }
  if (!QWEN_API_KEY) {
    return res.status(500).json({ error: "Server is missing QWEN_API_KEY" });
  }

  const [today, rates] = await Promise.all([formatToday(), getExchangeRates()]);
  const prompt = buildPrompt(lines, lineIndex, { today, rates });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);

    const r = await fetch(`${DASHSCOPE_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${QWEN_API_KEY}`,
      },
      body: JSON.stringify({
        model: QWEN_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        max_tokens: 60,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!r.ok) {
      const errText = await r.text();
      console.error("DashScope error", r.status, errText);
      return res.status(502).json({ error: `Upstream error ${r.status}` });
    }

    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content ?? "";
    const parsed = extractResult(content);
    res.json({
      result: parsed ? parsed.value : null,
      resultType: parsed ? parsed.type : null,
      raw: content,
    });
  } catch (e) {
    const isAbort = e.name === "AbortError";
    console.error("Evaluate failed:", e.message);
    res.status(isAbort ? 504 : 500).json({ error: isAbort ? "Upstream timeout" : "Request failed" });
  }
});

app.listen(PORT, () => {
  console.log(`Notepad Calculator fallback server running on http://localhost:${PORT}`);
  console.log(`Model: ${QWEN_MODEL} · Key loaded: ${QWEN_API_KEY ? "yes" : "NO (set QWEN_API_KEY in .env)"}`);
});
