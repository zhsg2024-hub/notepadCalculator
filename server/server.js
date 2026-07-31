require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { QWEN_MODEL, buildPrompt, extractResult, evaluateWithQwen } = require("./qwen");

const PORT = process.env.PORT || 8787;
const QWEN_API_KEY = process.env.QWEN_API_KEY;

if (!QWEN_API_KEY) {
  console.warn("⚠️  QWEN_API_KEY is not set. Copy .env.example to .env and fill in your key.");
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (req, res) => {
  res.json({ ok: true, model: QWEN_MODEL, hasKey: !!QWEN_API_KEY });
});

app.post("/api/evaluate", async (req, res) => {
  const { lines, lineIndex } = req.body || {};
  if (!Array.isArray(lines) || typeof lineIndex !== "number") {
    return res.status(400).json({ error: "Expected { lines: string[], lineIndex: number }" });
  }

  try {
    const data = await evaluateWithQwen(lines, lineIndex);
    res.json(data);
  } catch (e) {
    console.error("Evaluate failed:", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Only auto-start the server when run directly (`node server.js` / `npm start`),
// not when required by tests (e.g. tests/server-extract-result.test.js).
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Notepad Calculator fallback server running on http://localhost:${PORT}`);
    console.log(`Model: ${QWEN_MODEL} · Key loaded: ${QWEN_API_KEY ? "yes" : "NO (set QWEN_API_KEY in .env)"}`);
  });
}

module.exports = { extractResult, buildPrompt };
