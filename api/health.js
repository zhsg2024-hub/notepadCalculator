/**
 * Vercel serverless function — GET /api/health
 * Mirrors server/server.js's /api/health for local dev; lets the frontend's
 * AI-fallback status indicator work the same way in both environments.
 */
const { QWEN_MODEL } = require("../server/qwen");

module.exports = (req, res) => {
  const hasKey = !!process.env.QWEN_API_KEY;
  res.status(200).json({ ok: true, model: QWEN_MODEL, hasKey });
};
