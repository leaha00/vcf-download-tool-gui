// The CLI prints a "banner", status lines, then a pipe-delimited table:
//
// -----------------------------------------------------
// ID    | Component | Component Full Name | Version ...
// -----------------------------------------------------
// abc.. | VCENTER    | VMware vCenter      | 9.1.0...
// -----------------------------------------------------
// 74 elements
// -----------------------------------------------------
//
// Rather than rely on fixed column widths (which vary run to run based on
// content length), collect every line containing "|" - the first is the
// header, the rest are rows. Separator/summary lines never contain "|" so
// they're naturally excluded.
function parseTable(stdout) {
  const pipeLines = stdout
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.includes('|'));

  if (pipeLines.length === 0) {
    return [];
  }

  const splitRow = (line) => line.split('|').map((cell) => cell.trim());

  const headerCells = splitRow(pipeLines[0]).map((h) =>
    h
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
  );

  const rows = [];
  for (let i = 1; i < pipeLines.length; i++) {
    const cells = splitRow(pipeLines[i]);
    if (cells.length !== headerCells.length) continue;
    const row = {};
    headerCells.forEach((key, idx) => {
      row[key] = cells[idx];
    });
    rows.push(row);
  }
  return rows;
}

module.exports = { parseTable };
