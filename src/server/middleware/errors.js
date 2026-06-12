// Wraps an async route handler so unhandled rejections become a clean
// 502 instead of a crashed worker. The original error message is logged
// server-side; the client only sees a generic upstream-error response.
export const wrap = (fn) => (req, res) => fn(req, res).catch(e => {
  console.error(`${req.path}:`, e.message);
  // A throw after a partial response must not crash the catch handler itself.
  if (res.headersSent) return res.destroy();
  res.status(502).json({ detail: 'Upstream service error' });
});
