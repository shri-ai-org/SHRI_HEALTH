/**
 * Saving a file the page made — a Blob and a temporary link, nothing sent
 * anywhere. CSV cells are quoted where they need it, and a cell that a
 * spreadsheet would run as a formula (= + - @ at the start) is prefixed with
 * an apostrophe, so an exported file is safe to open.
 */

export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function csvCell(value: string | number): string {
  let v = String(value)
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

export const csvRow = (cells: (string | number)[]) => cells.map(csvCell).join(',')
