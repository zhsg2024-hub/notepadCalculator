/**
 * Vercel serverless function — POST /api/evaluate
 * Mirrors server/server.js's /api/evaluate route for local dev, using the
 * same shared logic in server/qwen.js. Set QWEN_API_KEY (and optionally
 * QWEN_MODEL) as environment variables in the Vercel project settings.
 */
const { evaluateWithQwen } = require("../server/qwen");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { lines, lineIndex } = req.body || {};
  if (!Array.isArray(lines) || typeof lineIndex !== "number") {
    res.status(400).json({ error: "Expected { lines: string[], lineIndex: number }" });
    return;
  }

  try {
    const data = await evaluateWithQwen(lines, lineIndex);
    res.status(200).json(data);
  } catch (e) {
    console.error("Evaluate failed:", e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
};
