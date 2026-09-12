import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export type ParsedPdf = { pages: number; extractedPages: number; text: string; truncated: boolean };

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 40;
const MAX_TEXT_CHARS = 100_000;

/** Fetches and reads a PDF locally in the extension. The PDF bytes are not sent to a third party. */
export async function readPdfFromUrl(url: string): Promise<ParsedPdf> {
  const target = new URL(url);
  if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("PDF URLs must use http or https.");
  const response = await fetch(target, { credentials: "include" });
  if (!response.ok) throw new Error(`PDF download failed with ${response.status}.`);
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_BYTES) throw new Error("PDFs larger than 20 MB are not read automatically.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new Error("PDFs larger than 20 MB are not read automatically.");

  const loading = getDocument({ data: bytes });
  const pdf = await loading.promise;
  try {
    const extractedPages = Math.min(pdf.numPages, MAX_PAGES);
    const parts: string[] = [];
    for (let pageNumber = 1; pageNumber <= extractedPages && parts.join("\n").length < MAX_TEXT_CHARS; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ").trim();
      parts.push(`Page ${pageNumber}: ${pageText}`);
    }
    const fullText = parts.join("\n\n");
    return { pages: pdf.numPages, extractedPages, text: fullText.slice(0, MAX_TEXT_CHARS), truncated: pdf.numPages > extractedPages || fullText.length > MAX_TEXT_CHARS };
  } finally {
    await loading.destroy();
  }
}

export function formatParsedPdf(pdf: ParsedPdf): string {
  return [`Read ${pdf.extractedPages} of ${pdf.pages} PDF pages${pdf.truncated ? " (truncated)" : ""}.`, pdf.text].filter(Boolean).join("\n\n");
}
