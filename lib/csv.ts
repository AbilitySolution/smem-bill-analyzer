export function toCsv(rows: (string | number | null)[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const value = cell == null ? "" : String(cell);
          return /[",;\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
        })
        .join(";"),
    )
    .join("\n");
}

export function downloadCsv(filename: string, rows: (string | number | null)[][]) {
  const csv = "﻿" + toCsv(rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
