import { createClient } from "@/lib/supabase/server";
import { PdfViewer } from "@/components/factures/pdf-viewer";
import { SplitPane } from "@/components/factures/split-pane";
import { ExtractionPanel, type ExtractionData } from "@/components/factures/extraction-panel";
import { InvoicePicker, type PickerInvoice } from "@/components/documents/invoice-picker";
import { ScanText } from "lucide-react";

type Row = Record<string, string | number | boolean | null>;

export default async function ExtractionPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  const supabase = await createClient();

  // Liste légère pour le sélecteur
  const { data: list } = await supabase
    .from("invoices")
    .select("id, facture_number, facture_date, categorie, is_duplicata, sites(nom), communes(nom)")
    .eq("archived", false)
    .order("facture_date", { ascending: false });

  const pickerInvoices: PickerInvoice[] = (list ?? []).map((i: Record<string, unknown>) => ({
    id: i.id as string,
    number: (i.facture_number as string) ?? "—",
    date: (i.facture_date as string) ?? "",
    categorie: (i.categorie as "batiment" | "eclairage_public") ?? "batiment",
    isDuplicata: !!i.is_duplicata,
    site: ((i.sites as { nom: string } | null)?.nom) ?? "—",
    commune: ((i.communes as { nom: string } | null)?.nom) ?? "—",
  }));

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 px-6 pb-3 pt-4">
        <InvoicePicker invoices={pickerInvoices} currentId={id} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden px-6 pb-5">
        {id ? <Detail id={id} /> : <EmptyState />}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--kn-border)] bg-[var(--kn-panel)] text-center text-[var(--kn-text-muted)]">
      <ScanText className="size-9" strokeWidth={1.4} />
      <div>
        <p className="text-[14px] font-medium text-[var(--kn-text)]">Sélectionnez une facture à étudier</p>
        <p className="text-[12px]">Utilisez le sélecteur ci-dessus (recherche, commune, site, année) ou cliquez une facture dans l&apos;onglet Documents.</p>
      </div>
    </div>
  );
}

async function Detail({ id }: { id: string }) {
  const supabase = await createClient();

  const { data: invoice } = await supabase
    .from("invoices")
    .select("*, clients(*), contracts(*), sites(*), communes(nom)")
    .eq("id", id)
    .single();

  if (!invoice) {
    return <div className="flex h-full items-center justify-center text-[13px] text-[var(--kn-text-muted)]">Facture introuvable.</div>;
  }

  const [{ data: consumption }, { data: charges }] = await Promise.all([
    supabase.from("consumption_periods").select("*").eq("invoice_id", id).order("period_start"),
    supabase.from("invoice_charges").select("*").eq("invoice_id", id),
  ]);

  const { data: signed } = invoice.file_path
    ? await supabase.storage.from("invoice-files").createSignedUrl(invoice.file_path, 3600)
    : { data: null };

  const inv = invoice as unknown as Row & {
    id: string; facture_number: string; precision: Record<string, number> | null;
    clients: (Row & { id: string }) | null;
    contracts: (Row & { id: string }) | null;
    sites: (Row & { id: string; nom: string }) | null;
  };

  const filename = `${inv.facture_number || "facture"}.pdf`;

  const extraction: ExtractionData = {
    invoice: inv as ExtractionData["invoice"],
    client: inv.clients,
    contract: inv.contracts,
    site: inv.sites,
    consumption: (consumption ?? []) as (Row & { id: string })[],
    charges: (charges ?? []) as (Row & { id: string })[],
  };

  return (
    <SplitPane
      left={<PdfViewer url={signed?.signedUrl ?? null} filename={filename} />}
      right={<ExtractionPanel data={extraction} />}
    />
  );
}
