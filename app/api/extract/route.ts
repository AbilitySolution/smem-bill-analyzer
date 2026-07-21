import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAnthropicClient, OCR_MODEL, retryWithBackoff } from "@/lib/anthropic/client";
import {
  invoiceExtractionSchema,
  invoiceExtractionToolSchema,
} from "@/lib/anthropic/invoice-schema";
import { validateInvoice } from "@/lib/anthropic/invoice-validation";
import { EXTRACTION_PROMPT, SYSTEM_PROMPT } from "@/lib/anthropic/extract-prompt";
import { matchCommune } from "@/lib/invoices/commune-match";
import { toUserSafeError } from "@/lib/ai/error";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Fichier manquant." }, { status: 400 });
  }

  const allowedTypes = ["application/pdf", "image/png", "image/jpeg", "image/webp"];
  if (!allowedTypes.includes(file.type)) {
    return NextResponse.json(
      { error: "Format non supporté. PDF, PNG, JPEG ou WEBP requis." },
      { status: 400 },
    );
  }

  const arrayBuffer = await file.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");

  const safeName = file.name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9.-]/g, "_");
  const storagePath = `${authData.user.id}/${Date.now()}-${safeName}`;
  const { error: uploadError } = await supabase.storage
    .from("invoice-files")
    .upload(storagePath, arrayBuffer, { contentType: file.type });

  if (uploadError) {
    return NextResponse.json({ error: `Upload échoué: ${uploadError.message}` }, { status: 500 });
  }

  const documentBlock =
    file.type === "application/pdf"
      ? { type: "document" as const, source: { type: "base64" as const, media_type: "application/pdf" as const, data: base64 } }
      : {
          type: "image" as const,
          source: { type: "base64" as const, media_type: file.type as "image/png" | "image/jpeg" | "image/webp", data: base64 },
        };

  try {
    const anthropic = createAnthropicClient();
    // retryWithBackoff gère les 429 (rate limit) et 529 (overload) transitoires — 3 tentatives.
    const response = await retryWithBackoff(() =>
      anthropic.messages.create({
        model: OCR_MODEL,
        max_tokens: 8192, // 4096 tronquait les factures multi-périodes complexes
        system: SYSTEM_PROMPT,
        tools: [invoiceExtractionToolSchema],
        tool_choice: { type: "tool", name: "extract_edf_invoice" },
        messages: [
          {
            role: "user",
            content: [documentBlock, { type: "text", text: EXTRACTION_PROMPT }],
          },
        ],
      })
    );

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      return NextResponse.json({ error: "Le service n'a pas retourné d'extraction." }, { status: 502 });
    }

    const parsed = invoiceExtractionSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Extraction invalide.", details: parsed.error.format() },
        { status: 502 },
      );
    }

    // Rapprochement de commune (lib partagée). Suggestion retenue si score ≥ 0.5.
    const { data: allCommunes } = await supabase.from("communes").select("id, nom");
    const communeMatch = matchCommune(
      [parsed.data.commune_hint, parsed.data.contract.espace_livraison, parsed.data.client.adresse, parsed.data.client.nom],
      allCommunes ?? [],
    );
    const suggested_commune_id = communeMatch && communeMatch.score >= 0.5 ? communeMatch.id : null;
    const suggested_commune_nom = communeMatch && communeMatch.score >= 0.5 ? communeMatch.nom : null;

    // Le site n'est plus hérité du contrat (source de faux sites) : il est résolu à l'enregistrement
    // depuis l'espace de livraison de la facture.
    const suggested_site_id: string | null = null;
    const suggested_site_nom: string | null = null;

    const validation = validateInvoice(parsed.data);

    return NextResponse.json({
      extraction: parsed.data,
      file_path: storagePath,
      suggested_commune_id,
      suggested_commune_nom,
      suggested_site_id,
      suggested_site_nom,
      validation,
    });
  } catch (err) {
    const { userMessage, logMessage } = toUserSafeError(err);
    console.error("[api/extract] OCR error:", logMessage);
    return NextResponse.json({ error: userMessage }, { status: 500 });
  }
}
