import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { invoiceExtractionSchema } from "@/lib/anthropic/invoice-schema";
import { z } from "zod";

const saveRequestSchema = z.object({
  extraction: invoiceExtractionSchema,
  file_path: z.string(),
});

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const parsed = saveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Données invalides.", details: parsed.error.format() },
      { status: 400 },
    );
  }

  const { extraction, file_path } = parsed.data;

  // 1. Upsert client (match on reference_compte if present, else nom).
  const { data: existingClient } = await supabase
    .from("clients")
    .select("id")
    .or(
      extraction.client.reference_compte
        ? `reference_compte.eq.${extraction.client.reference_compte}`
        : `nom.eq.${extraction.client.nom}`,
    )
    .limit(1)
    .maybeSingle();

  let clientId = existingClient?.id as string | undefined;
  if (!clientId) {
    const { data: newClient, error: clientError } = await supabase
      .from("clients")
      .insert({
        nom: extraction.client.nom,
        reference_client: extraction.client.reference_client,
        reference_compte: extraction.client.reference_compte,
        adresse: extraction.client.adresse,
      })
      .select("id")
      .single();

    if (clientError) {
      return NextResponse.json({ error: `Client: ${clientError.message}` }, { status: 500 });
    }
    clientId = newClient.id;
  }

  // 2. Upsert contract (unique on contract_number).
  const { data: existingContract } = await supabase
    .from("contracts")
    .select("id")
    .eq("contract_number", extraction.contract.contract_number)
    .maybeSingle();

  let contractId = existingContract?.id as string | undefined;
  if (!contractId) {
    const { data: newContract, error: contractError } = await supabase
      .from("contracts")
      .insert({ ...extraction.contract, client_id: clientId })
      .select("id")
      .single();

    if (contractError) {
      return NextResponse.json({ error: `Contrat: ${contractError.message}` }, { status: 500 });
    }
    contractId = newContract.id;
  }

  // 3. Insert invoice header. Reject upfront if facture_number already saved
  // (re-submitting the same invoice after a failed attempt should edit the
  // existing row, not create a duplicate).
  const { data: existingInvoice } = await supabase
    .from("invoices")
    .select("id")
    .eq("facture_number", extraction.invoice.facture_number)
    .maybeSingle();

  if (existingInvoice) {
    return NextResponse.json(
      { error: `Facture ${extraction.invoice.facture_number} déjà enregistrée.` },
      { status: 409 },
    );
  }

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .insert({
      ...extraction.invoice,
      contract_id: contractId,
      client_id: clientId,
      file_path,
      status: "reviewed",
      created_by: authData.user.id,
      raw_ocr_json: extraction,
    })
    .select("id")
    .single();

  if (invoiceError) {
    return NextResponse.json({ error: `Facture: ${invoiceError.message}` }, { status: 500 });
  }

  const invoiceId = invoice.id;

  // 4. Insert child rows.
  const childInserts = await Promise.all([
    extraction.consumption_history.length
      ? supabase
          .from("consumption_history")
          .insert(extraction.consumption_history.map((row) => ({ ...row, invoice_id: invoiceId })))
      : Promise.resolve({ error: null }),
    extraction.fixed_charges.length
      ? supabase
          .from("invoice_fixed_charges")
          .insert(extraction.fixed_charges.map((row) => ({ ...row, invoice_id: invoiceId })))
      : Promise.resolve({ error: null }),
    extraction.consumption_lines.length
      ? supabase
          .from("invoice_consumption_lines")
          .insert(extraction.consumption_lines.map((row) => ({ ...row, invoice_id: invoiceId })))
      : Promise.resolve({ error: null }),
    extraction.taxes.length
      ? supabase
          .from("invoice_taxes")
          .insert(extraction.taxes.map((row) => ({ ...row, invoice_id: invoiceId })))
      : Promise.resolve({ error: null }),
  ]);

  const childError = childInserts.find((r) => r.error)?.error;
  if (childError) {
    // Compensating delete: don't leave an orphan invoice row with no detail
    // lines, which would block re-submission with a unique constraint error.
    await supabase.from("invoices").delete().eq("id", invoiceId);
    return NextResponse.json({ error: `Détails facture: ${childError.message}` }, { status: 500 });
  }

  return NextResponse.json({ invoice_id: invoiceId });
}
