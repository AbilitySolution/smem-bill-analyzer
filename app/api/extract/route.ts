import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "@/lib/auth";
import { createAnthropicClient, retryWithBackoff } from "@/lib/anthropic/client";
import {
  buildExtractionParams,
  parseExtractionResponse,
  isExtractionMediaType,
} from "@/lib/anthropic/extraction-request";
import { matchCommune, matchSiteByContract } from "@/lib/extraction/matching";
import { validateInvoiceInContext } from "@/lib/invoices/contextual-validation";
import { EXTRACTOR_VERSION } from "@/lib/anthropic/extractor-version";
import { buildInvoiceStoragePath } from "@/lib/extraction/storage-path";

export async function POST(request: Request) {
  const supabase = await createClient();
  const ctx = await getUserContext();
  if (!ctx) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Fichier manquant." }, { status: 400 });
  }

  // Capturé dans une const : après un `await`, TypeScript ne conserve pas le
  // rétrécissement de type obtenu sur un accès de propriété.
  const mediaType = file.type;
  if (!isExtractionMediaType(mediaType)) {
    return NextResponse.json(
      { error: "Format non supporté. PDF, PNG, JPEG ou WEBP requis." },
      { status: 400 },
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");

  const storagePath = buildInvoiceStoragePath(ctx.orgId, ctx.userId, file.name);
  const { error: uploadError } = await supabase.storage
    .from("invoice-files")
    .upload(storagePath, arrayBuffer, { contentType: mediaType });

  if (uploadError) {
    return NextResponse.json({ error: `Upload échoué: ${uploadError.message}` }, { status: 500 });
  }

  try {
    const anthropic = createAnthropicClient();
    // retryWithBackoff gère les 429 (rate limit) et 529 (overload) transitoires — 3 tentatives.
    const response = await retryWithBackoff(() =>
      anthropic.messages.create(buildExtractionParams(base64, mediaType)),
    );

    const parsed = parseExtractionResponse(response.content);
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error, details: parsed.details }, { status: 502 });
    }

    const commune = await matchCommune(supabase, ctx.orgId, parsed.data);
    const site = commune
      ? await matchSiteByContract(supabase, ctx.orgId, commune.id, parsed.data.contract.contract_number)
      : null;

    // Validation replacée dans l'historique du contrat : la continuité des index d'une
    // facture à l'autre ne se voit pas sur un document isolé.
    const validation = await validateInvoiceInContext(supabase, parsed.data, { orgId: ctx.orgId });

    return NextResponse.json({
      extraction: parsed.data,
      // Provenance à reporter dans la requête d'enregistrement, pour que la facture
      // garde trace de l'extracteur qui l'a produite.
      extractor_version: EXTRACTOR_VERSION,
      file_path: storagePath,
      suggested_commune_id: commune?.id ?? null,
      suggested_commune_nom: commune?.nom ?? null,
      suggested_site_id: site?.id ?? null,
      suggested_site_nom: site?.nom ?? null,
      validation,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur OCR inconnue.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
