import { DocumentsHub } from "@/components/documents/documents-hub";
import { getInvoiceDocs, DEMO_INVOICE_DOCS, type InvoiceDoc } from "@/lib/data/invoices";
import { createClient } from "@/lib/supabase/server";

export default async function DocumentsPage() {
  let docs: InvoiceDoc[] = DEMO_INVOICE_DOCS;
  let isDemo = true;
  try {
    const real = await getInvoiceDocs();
    if (real && real.length) {
      docs = real;
      isDemo = false;
      docs = await attachPreviews(docs);
    }
  } catch {
    // hors session / RLS — repli démo
  }
  return <DocumentsHub docs={docs} isDemo={isDemo} />;
}

/** Génère en lot les URLs signées des PDF pour les vignettes (galerie / aperçu). */
async function attachPreviews(docs: InvoiceDoc[]): Promise<InvoiceDoc[]> {
  const paths = docs.map((d) => d.filePath).filter((p): p is string => !!p);
  if (!paths.length) return docs;
  try {
    const supabase = await createClient();
    const { data } = await supabase.storage.from("invoice-files").createSignedUrls(paths, 3600);
    const byPath = new Map((data ?? []).filter((s) => s.signedUrl).map((s) => [s.path, s.signedUrl]));
    return docs.map((d) => (d.filePath ? { ...d, previewUrl: byPath.get(d.filePath) ?? null } : d));
  } catch {
    return docs;
  }
}
