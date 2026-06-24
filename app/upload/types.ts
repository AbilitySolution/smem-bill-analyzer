import type { InvoiceExtraction } from "@/lib/anthropic/invoice-schema";

export interface ExtractResponse {
  extraction: InvoiceExtraction;
  file_path: string;
}

export interface ExtractError {
  error: string;
  details?: unknown;
}
