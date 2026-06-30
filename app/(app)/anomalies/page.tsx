import { getInvoiceDocs, type InvoiceDoc } from "@/lib/data/invoices";
import { AnomaliesView } from "@/components/anomalies/anomalies-view";

export default async function AnomaliesPage({ searchParams }: { searchParams: Promise<{ focus?: string }> }) {
  const { focus } = await searchParams;

  let docs: InvoiceDoc[] = [];
  try {
    const all = await getInvoiceDocs();
    if (all) docs = all.filter((d) => !d.archived && (d.anomalies?.length ?? 0) > 0);
  } catch {
    docs = [];
  }

  return <AnomaliesView docs={docs} focus={focus} />;
}
