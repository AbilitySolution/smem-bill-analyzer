import { getInvoiceDocs, type InvoiceDoc } from "@/lib/data/invoices";
import { getAnomalyContext, type AnomalyContext } from "@/lib/data/anomaly-context";
import { AnomaliesView } from "@/components/anomalies/anomalies-view";

export default async function AnomaliesPage({ searchParams }: { searchParams: Promise<{ focus?: string }> }) {
  const { focus } = await searchParams;

  // Le contexte de consommation alimente les sparklines et le taux d'anomalie par site.
  // Son échec ne doit pas priver l'utilisateur de la liste des alertes, qui reste
  // parfaitement lisible sans graphique : d'où `allSettled` plutôt qu'un `all` qui
  // ferait tomber les deux ensemble.
  const [docsResult, contextResult] = await Promise.allSettled([getInvoiceDocs(), getAnomalyContext()]);

  const all: InvoiceDoc[] = docsResult.status === "fulfilled" ? docsResult.value ?? [] : [];
  const docs = all.filter((d) => !d.archived && (d.anomalies?.length ?? 0) > 0);
  const context: AnomalyContext | null = contextResult.status === "fulfilled" ? contextResult.value : null;

  return <AnomaliesView docs={docs} context={context} focus={focus} />;
}
