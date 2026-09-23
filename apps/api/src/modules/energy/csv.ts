/** CSV 序列化工具：生成带 UTF-8 BOM 的 CSV，保证 Excel 中文不乱码。 */
export interface CsvColumn {
  key: string;
  label: string;
}

function escapeCell(value: unknown): string {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns: CsvColumn[]): string {
  const header = columns.map((c) => escapeCell(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => escapeCell(r[c.key])).join(',')).join('\r\n');
  return `\ufeff${header}\r\n${body}`;
}
