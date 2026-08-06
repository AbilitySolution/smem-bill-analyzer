import { getInvoiceDocs, getPortfolioScatter, type InvoiceDoc, type PortfolioPoint } from "@/lib/data/invoices";
import { AnomaliesView } from "@/components/anomalies/anomalies-view";

export default async function AnomaliesPage({ searchParams }: { searchParams: Promise<{ focus?: string }> }) {
  const { focus } = await searchParams;

  let docs: InvoiceDoc[] = [];
  let portfolio: PortfolioPoint[] | null = null;
  try {
    const [all, points] = await Promise.all([getInvoiceDocs(), getPortfolioScatter()]);
    if (all) docs = all.filter((d) => !d.archived && (d.anomalies?.length ?? 0) > 0);
    portfolio = points;
  } catch {
    docs = [];
  }

  return <AnomaliesView docs={docs} portfolio={portfolio} focus={focus} />;
}
