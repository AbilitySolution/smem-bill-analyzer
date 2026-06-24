import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: invoice } = await supabase.from("invoices").select("*").eq("id", id).single();

  if (!invoice) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-16 text-center">
        <p className="text-sm text-slate-600">Facture introuvable.</p>
        <Link href="/upload" className="mt-4 inline-block text-sm text-[#1E40AF] hover:underline">
          Importer une facture
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="mb-2 text-lg font-semibold text-[#1E3A8A]">
        Facture {invoice.facture_number} enregistrée
      </h1>
      <p className="text-sm text-slate-600">Total TTC : {invoice.total_ttc} €</p>
      <p className="text-sm text-slate-600">Statut : {invoice.status}</p>
      <Link href="/upload" className="mt-6 inline-block text-sm text-[#1E40AF] hover:underline">
        Importer une autre facture
      </Link>
    </main>
  );
}
