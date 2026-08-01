// Mirrors the client-side parseSize in public/app.js. Converts the CLI's
// "14.9 GiB" style size strings to bytes for progress-percentage math.
function parseSize(str) {
  const m = /^([\d.]+)\s*(KiB|MiB|GiB|TiB|B)$/i.exec((str || '').trim());
  if (!m) return 0;
  const val = parseFloat(m[1]);
  const mult = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 }[m[2]];
  return val * mult;
}

module.exports = { parseSize };
