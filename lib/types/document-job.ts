import type { InvoiceExtraction } from "@/lib/anthropic/invoice-schema";
import type { ValidationResult } from "@/lib/anthropic/invoice-validation";

export type DocumentJobStatus = "direct_queued" | "direct_processing" | "queued" | "uploading_to_claude" | "batched" | "processing" | "needs_review" | "completed" | "failed";

export interface DocumentJob {
  id: string;
  original_name: string;
  mime_type: string;
  file_size: number;
  status: DocumentJobStatus;
  processing_mode: "direct" | "batch";
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  queued_at?: string;
  dispatch_started_at?: string | null;
  claude_file_uploaded_at?: string | null;
  batch_created_at?: string | null;
  result_available_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  extraction_json?: InvoiceExtraction | null;
  validation_json?: ValidationResult | null;
  file_path?: string;
  suggested_commune_id?: string | null;
  suggested_site_id?: string | null;
  processed_invoice_id?: string | null;
  anthropic_file_id?: string | null;
  anthropic_batch_id?: string | null;
}
