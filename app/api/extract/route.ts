import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAnthropicClient, OCR_MODEL } from "@/lib/anthropic/client";
import {
  invoiceExtractionSchema,
  invoiceExtractionToolSchema,
} from "@/lib/anthropic/invoice-schema";

const EXTRACTION_PROMPT = `Tu analyses une facture EDF (électricité). Extrait toutes les données structurées de cette facture en utilisant l'outil extract_edf_invoice.

Règles importantes :
- Toutes les dates au format ISO 8601 (YYYY-MM-DD).
- Les montants en nombres (pas de texte, pas de symbole €), avec le point comme séparateur décimal.
- N'extrait PAS le tableau d'aperçu/historique en première page (ex: "févr 22 / août 22 / févr 23") — ce sont des résumés d'autres factures déjà capturées ailleurs, source de doublons.
- consumption_periods : uniquement les lignes "part variable" au verso avec index ancien/nouveau de compteur réels. Une ligne par période de barème si plusieurs barèmes existent pour la même période de relevé.
- charges : toutes les lignes "part fixe / abonnement" (category="fixed") ET toutes les lignes de la section "Taxes et contributions" (category="tax"), une ligne par taxe/période (ex: CSPE peut apparaître plusieurs fois pour des sous-périodes différentes — garder chaque occurrence séparée). taux_unit = "eur_per_kwh" si le taux est exprimé en €/kWh, "percent" si en %.
- Si une valeur n'est pas présente sur la facture, mets null (jamais d'invention de données).
- is_duplicata = true si le mot "DUPLICATA" apparaît sur le document.`;

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
    .replace(/[\u0300-\u036f]/g, "")
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
    const response = await anthropic.messages.create({
      model: OCR_MODEL,
      max_tokens: 4096,
      tools: [invoiceExtractionToolSchema],
      tool_choice: { type: "tool", name: "extract_edf_invoice" },
      messages: [
        {
          role: "user",
          content: [documentBlock, { type: "text", text: EXTRACTION_PROMPT }],
        },
      ],
    });

    const toolUse = response.content.find((block) => block.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      return NextResponse.json({ error: "Claude n'a pas retourné d'extraction." }, { status: 502 });
    }

    const parsed = invoiceExtractionSchema.safeParse(toolUse.input);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Extraction invalide.", details: parsed.error.format() },
        { status: 502 },
      );
    }

    return NextResponse.json({ extraction: parsed.data, file_path: storagePath });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur OCR inconnue.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
