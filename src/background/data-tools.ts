import Papa from "papaparse";

export type ParsedTable = {
  headers: string[];
  rows: Record<string, string>[];
  truncated: boolean;
  errors: string[];
};

const MAX_INPUT_CHARS = 1_000_000;
const MAX_ROWS = 1_000;
const MAX_COLUMNS = 50;

/** Parses delimited text locally. It never fetches URLs or sends the document anywhere. */
export function parseDelimitedText(text: string, delimiter?: string): ParsedTable {
  if (text.length > MAX_INPUT_CHARS) throw new Error("CSV input is limited to 1 MB.");
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    dynamicTyping: false,
    ...(delimiter ? { delimiter } : {}),
    preview: MAX_ROWS + 1,
  });
  const headers = result.meta.fields?.slice(0, MAX_COLUMNS) ?? [];
  const rows = result.data.slice(0, MAX_ROWS).map(row => Object.fromEntries(headers.map(header => [header, String(row[header] ?? "")] )));
  return {
    headers,
    rows,
    truncated: result.data.length > MAX_ROWS,
    errors: result.errors.map(error => error.message).slice(0, 10),
  };
}

export function formatParsedTable(table: ParsedTable): string {
  const preview = table.rows.slice(0, 20).map(row => JSON.stringify(row)).join("\n");
  return [
    `Parsed ${table.rows.length}${table.truncated ? "+" : ""} rows with columns: ${table.headers.join(", ") || "none"}.`,
    table.errors.length ? `Warnings: ${table.errors.join("; ")}` : "",
    preview ? `Rows:\n${preview}` : "",
  ].filter(Boolean).join("\n");
}
