import { createClient } from "@/lib/supabase/server";
import { PdfViewer } from "@/components/factures/pdf-viewer";
import { SplitPane } from "@/components/factures/split-pane";
import { InvoiceEditPanel, type InvoiceEditData } from "@/components/factures/invoice-edit-panel";
import { InvoicePicker, type PickerInvoice } from "@/components/documents/invoice-picker";
import { ScanText } from "lucide-react";

type Row = Record<string, unknown>;

async function selectAllInvoices(
  supabase: Awaited<ReturnType<typeof createClient>>,
  pageSize = 1000,
) {
  const out: Record<string, unknown>[] = [];
  let start = 0;
  while (true) {
    const { data, error } = await supabase
      .from("invoices")
      .select("id, facture_number, facture_date, categorie, is_duplicata, sites(nom), communes(nom)")
      .eq("archived", false)
      .order("facture_date", { ascending: false })
      .range(start, start + pageSize - 1);
    if (error || !data) return out;
    out.push(...data);
    if (data.length < pageSize) return out;
    start += pageSize;
  }
}

export default async function ExtractionPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  const supabase = await createClient();

  // Liste légère pour le sélecteur
  const list = await selectAllInvoices(supabase);

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

  const [{ data: invoice }, { data: communes }] = await Promise.all([
    supabase.from("invoices").select("*, clients(*), contracts(*), sites(*), invoice_tags(tags(id, label, color))").eq("id", id).single(),
    supabase.from("communes").select("id, nom").order("nom"),
  ]);

  if (!invoice) {
    return <div className="flex h-full items-center justify-center text-[13px] text-[var(--kn-text-muted)]">Facture introuvable.</div>;
  }

  const [{ data: consumption }, { data: charges }] = await Promise.all([
    supabase.from("consumption_periods").select("*").eq("invoice_id", id).order("period_start"),
    supabase.from("invoice_charges").select("*").eq("invoice_id", id),
  ]);

  const { data: signed } = invoice.file_path
    ? await supabase.storage.from("invoice-files").createSignedUrl(invoice.file_path as string, 3600)
    : { data: null };

  const inv = invoice as Row;
  const client = (inv.clients as Row | null);
  const contract = (inv.contracts as Row | null);

  const filename = `${(inv.facture_number as string) || "facture"}.pdf`;

  // Extract override comment from raw_ocr_json._override
  const rawJson = inv.raw_ocr_json as Record<string, unknown> | null;
  const overrideData = rawJson?._override as { comment: string; flag_anomaly: boolean } | undefined;

  // Extract tags from invoice_tags join
  type TagRow = { tags: { id: string; label: string; color: string } | null };
  const tagRows = (inv.invoice_tags as TagRow[] | null) ?? [];
  const invoiceTags = tagRows
    .map((r) => r.tags)
    .filter((t): t is { id: string; label: string; color: string } => t != null);

  const editData: InvoiceEditData = {
    invoiceId: id,
    communeId: (inv.commune_id as string) ?? "",
    categorie: ((inv.categorie as string) ?? "batiment") as "batiment" | "eclairage_public",
    clientId: (inv.client_id as string) ?? "",
    contractId: (inv.contract_id as string) ?? "",
    override: overrideData,
    tags: invoiceTags,
    invoice: {
      facture_number: (inv.facture_number as string) ?? "",
      facture_date: (inv.facture_date as string) ?? "",
      date_limite_paiement: (inv.date_limite_paiement as string | null) ?? null,
      total_ht: (inv.total_ht as number) ?? 0,
      tva: (inv.tva as number | null) ?? null,
      autres_taxes: (inv.autres_taxes as number | null) ?? null,
      total_ttc: (inv.total_ttc as number) ?? 0,
      is_duplicata: !!(inv.is_duplicata as boolean),
    },
    client: {
      nom: (client?.nom as string) ?? "",
      reference_client: (client?.reference_client as string | null) ?? null,
      reference_compte: (client?.reference_compte as string | null) ?? null,
      adresse: (client?.adresse as string | null) ?? null,
    },
    contract: {
      contract_number: (contract?.contract_number as string) ?? "",
      pdl: (contract?.pdl as string | null) ?? null,
      tarif_type: (contract?.tarif_type as string | null) ?? null,
      espace_livraison: (contract?.espace_livraison as string | null) ?? null,
      offre: (contract?.offre as string | null) ?? null,
      service: (contract?.service as string | null) ?? null,
      puissance_souscrite_kva: (contract?.puissance_souscrite_kva as number | null) ?? null,
      reglage_protection_a: (contract?.reglage_protection_a as number | null) ?? null,
      type_compteur: (contract?.type_compteur as string | null) ?? null,
      numero_compteur: (contract?.numero_compteur as string | null) ?? null,
    },
    consumption: (consumption ?? []).map((r) => ({
      poste_tarifaire: (r.poste_tarifaire as string) ?? "",
      period_start: (r.period_start as string | null) ?? null,
      period_end: (r.period_end as string | null) ?? null,
      numero_compteur: (r.numero_compteur as string | null) ?? null,
      ancien_index: (r.ancien_index as number | null) ?? null,
      nouveau_index: (r.nouveau_index as number | null) ?? null,
      coefficient: (r.coefficient as number) ?? 1,
      consommation_kwh: (r.consommation_kwh as number) ?? 0,
      prix_unitaire_ckwh: (r.prix_unitaire_ckwh as number | null) ?? null,
      montant_eur: (r.montant_eur as number) ?? 0,
      index_estime: !!(r.index_estime as boolean),
    })),
    charges: (charges ?? []).map((r) => ({
      category: (r.category as "fixed" | "tax") ?? "fixed",
      libelle: (r.libelle as string) ?? "",
      period_start: (r.period_start as string | null) ?? null,
      period_end: (r.period_end as string | null) ?? null,
      assiette: (r.assiette as number | null) ?? null,
      taux: (r.taux as string | null) ?? null,
      taux_numeric: (r.taux_numeric as number | null) ?? null,
      taux_unit: (r.taux_unit as string | null) ?? null,
      tarif_kva_an: (r.tarif_kva_an as number | null) ?? null,
      montant_eur: (r.montant_eur as number) ?? 0,
    })),
    communes: (communes ?? []) as { id: string; nom: string }[],
  };

  return (
    <SplitPane
      left={<PdfViewer url={signed?.signedUrl ?? null} filename={filename} />}
      right={<InvoiceEditPanel key={id} data={editData} />}
    />
  );
}
