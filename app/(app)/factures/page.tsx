import { FacturesList } from "@/components/factures/factures-list";
import { getInvoiceDocs, DEMO_INVOICE_DOCS } from "@/lib/data/invoices";

export default async function FacturesPage() {
  let docs = DEMO_INVOICE_DOCS;
  let isDemo = true;
  try {
    const real = await getInvoiceDocs();
    if (real && real.length) {
      docs = real;
      isDemo = false;
    }
  } catch {
    // hors session / RLS — repli démo
  }
  return <FacturesList docs={docs} isDemo={isDemo} />;
}
