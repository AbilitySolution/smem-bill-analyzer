import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAnthropicClient, OCR_MODEL } from "@/lib/anthropic/client";
import {
  invoiceExtractionSchema,
  invoiceExtractionToolSchema,
} from "@/lib/anthropic/invoice-schema";

const EXTRACTION_PROMPT = `Tu analyses une facture EDF (électricité) d'un bâtiment public ou d'un point d'éclairage public. Extrait toutes les données structurées de cette facture en utilisant l'outil extract_edf_invoice.

Règles importantes :
- Toutes les dates au format ISO 8601 (YYYY-MM-DD).
- Les montants en nombres (pas de texte, pas de symbole €), avec le point comme séparateur décimal.
- "historique de consommation" (tableau en-tête, plusieurs colonnes de périodes type "févr 22") va dans consumption_history. is_estime = true si la valeur est en italique sur la facture.
- Les lignes "part fixe / abonnement" vont dans fixed_charges.
- Les lignes "part variable" avec index ancien/nouveau de compteur vont dans consumption_lines. Une ligne par période de barème si plusieurs barèmes existent pour la même période de relevé.
- Toutes les lignes de la section "Taxes et contributions" vont dans taxes, une ligne par taxe/période. taux_unit = "eur_per_kwh" si le taux est exprimé en €/kWh, "percent" si en %.
- Si une valeur n'est pas présente sur la facture, mets null (jamais d'invention de données).
- is_duplicata = true si le mot "DUPLICATA" apparaît sur le document.
- precision : pour chaque champ clé de l'en-tête (facture_number, facture_date, total_ht, tva, autres_taxes, total_ttc), donne un score de confiance entre 0 et 1 (1 = valeur parfaitement lisible et certaine ; valeurs plus basses si le champ est flou, ambigu, déduit ou absent).`;

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
