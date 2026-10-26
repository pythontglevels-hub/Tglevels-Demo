// Vercel entry point: the whole Express app runs as one serverless function.
// vercel.json sends every /api/... request here; the page's own files are
// served straight from public/.
module.exports = require('../server/index.js');
