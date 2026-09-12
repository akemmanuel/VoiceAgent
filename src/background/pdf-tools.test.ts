import { describe, expect, test } from "bun:test";
import { formatParsedPdf } from "./pdf-tools";

describe("PDF tool formatting", () => {
  test("reports page limits with extracted text", () => {
    expect(formatParsedPdf({ pages: 60, extractedPages: 40, truncated: true, text: "Page 1: Invoice" }))
      .toBe("Read 40 of 60 PDF pages (truncated).\n\nPage 1: Invoice");
  });
});
