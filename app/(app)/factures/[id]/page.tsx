import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PdfViewer } from "@/components/factures/pdf-viewer";
import { SplitPane } from "@/components/factures/split-pane";
import { FactureActions } from "@/components/factures/facture-actions";
import { ExtractionPanel, type ExtractionData } from "@/components/factures/extraction-panel";
import { ChevronRight, FileWarning } from "lucide-react";

type Row = Record<string, string | number | boolean | null>;

export default async function FactureDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: invoice } = await supabase
    .from("invoices")
    .select("*, clients(*), contracts(*), sites(*), communes(nom)")
    .eq("id", id)
    .single();

  if (!invoice) notFound();

  const [{ data: consumption }, { data: charges }] = await Promise.all([
    supabase.from("consumption_periods").select("*").eq("invoice_id", id).order("period_start"),
    supabase.from("invoice_charges").select("*").eq("invoice_id", id),
  ]);

  const { data: signed } = invoice.file_path
    ? await supabase.storage.from("invoice-files").createSignedUrl(invoice.file_path, 3600)
    : { data: null };

  const inv = invoice as unknown as Row & {
    id: string; facture_number: string; is_duplicata: boolean; precision: Record<string, number> | null;
    clients: (Row & { id: string }) | null;
    contracts: (Row & { id: string }) | null;
    sites: (Row & { id: string; nom: string }) | null;
    communes: { nom: string } | null;
  };

  const totalKwh = (consumption ?? []).reduce((s, c) => s + (Number(c.consommation_kwh) || 0), 0);
  const filename = `${inv.facture_number || "facture"}.pdf`;

  const extraction: ExtractionData = {
    invoice: inv as ExtractionData["invoice"],
    client: inv.clients,
    contract: inv.contracts,
    site: inv.sites,
    consumption: (consumption ?? []) as (Row & { id: string })[],
    charges: (charges ?? []) as (Row & { id: string })[],
  };

  // CSV de la facture (en-tête + lignes de consommation)
  const csvData: (string | number | null)[][] = [
    ["Facture", inv.facture_number, "Date", String(inv.facture_date ?? ""), "Site", inv.sites?.nom ?? "", "Commune", inv.communes?.nom ?? ""],
    ["Total HT", Number(inv.total_ht) || 0, "TVA", Number(inv.tva) || 0, "Total TTC", Number(inv.total_ttc) || 0, "Conso (kWh)", totalKwh],
    [],
    ["Poste tarifaire", "Période début", "Période fin", "Conso (kWh)", "Prix (c€/kWh)", "Montant (€)"],
    ...(consumption ?? []).map((c) => [
      c.poste_tarifaire, c.period_start, c.period_end, c.consommation_kwh, c.prix_unitaire_ckwh, c.montant_eur,
    ]),
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Barre du haut */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--kn-border)] px-5">
        <div className="flex items-center gap-1.5 text-[13px]">
          <Link href="/factures" className="text-[var(--kn-text-muted)] hover:text-[#1a1a1a]">Factures</Link>
          <ChevronRight className="size-3.5 text-[var(--kn-text-muted)]" />
          <span className="font-medium text-[#1a1a1a]">{inv.facture_number}</span>
          {inv.is_duplicata && (
            <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-[#fef3c7] px-2 py-0.5 text-[11px] text-[#92400e]">
              <FileWarning className="size-3" /> Duplicata
            </span>
          )}
          <span className="ml-1 text-[12px] text-[var(--kn-text-muted)]">
            · {inv.sites?.nom ?? "—"} · {inv.communes?.nom ?? "—"}
          </span>
        </div>
        <FactureActions
          pdfUrl={signed?.signedUrl ?? null}
          filename={filename}
          csvName={`facture-${inv.facture_number || inv.id}.csv`}
          csvData={csvData}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden p-5">
        <SplitPane
          left={<PdfViewer url={signed?.signedUrl ?? null} filename={filename} />}
          right={<ExtractionPanel data={extraction} />}
        />
      </div>
    </div>
  );
}
