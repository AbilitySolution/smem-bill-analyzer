import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAnthropicClient, OCR_MODEL } from "@/lib/anthropic/client";
import {
  invoiceExtractionSchema,
  invoiceExtractionToolSchema,
} from "@/lib/anthropic/invoice-schema";

const EXTRACTION_PROMPT = `Tu analyses une facture EDF (électricité) d'un bâtiment public ou d'un point d'éclairage public. Extrait toutes les données structurées en utilisant l'outil extract_edf_invoice.

Règles importantes :
- Toutes les dates au format ISO 8601 (YYYY-MM-DD).
- Les montants en nombres (pas de texte, pas de symbole €), point comme séparateur décimal.
- PDL (Point De Livraison) : identifiant à 14 chiffres sur la facture, libellé "Réf. PDL", "N° PDL" ou similaire. Extraire dans contract.pdl. Si absent, null.
- tarif_type : normaliser en "BASE" (tarif unique), "HPHC" (heures pleines/creuses), "TEMPO" (bleu/blanc/rouge), "EJP". Déduire depuis l'offre ou le service. Si indéterminable, null.
- Les lignes "part fixe / abonnement" vont dans fixed_charges.
- Les lignes "part variable" avec index ancien/nouveau de compteur vont dans consumption_lines. Une ligne par combinaison (poste tarifaire × période). poste_tarifaire normalisé : HP, HC, BASE, TEMPO_HP, TEMPO_HC, EJP_HP, EJP_HPN — utiliser le libellé exact si inconnu.
- Toutes les lignes "Taxes et contributions" vont dans taxes, une par taxe/période. taux_unit = "eur_per_kwh" si en €/kWh, "percent" si en %.
- Si une valeur absente : null (jamais d'invention).
- is_duplicata = true si le mot "DUPLICATA" apparaît.
- commune_hint : nom de la commune tel qu'il apparaît sur la facture (adresse client, espace de livraison, ou en-tête). Copier le texte brut trouvé sur la facture sans normaliser. Null si absent.
- precision : score 0-1 pour chaque champ clé (1 = parfaitement lisible ; plus bas si flou, ambigu, déduit ou absent). Couvrir : facture_number, facture_date, total_ht, tva, autres_taxes, total_ttc, pdl, contract_number, puissance_souscrite_kva.`;

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

    // Fuzzy-match commune_hint against canonical list
    let suggested_commune_id: string | null = null;
    let suggested_commune_nom: string | null = null;
    const hint = parsed.data.commune_hint;
    if (hint) {
      const { data: match } = await supabase
        .rpc("match_commune", { input_text: hint })
        .maybeSingle() as { data: { commune_id: string; commune_nom: string; score: number } | null };
      if (match) {
        suggested_commune_id = match.commune_id;
        suggested_commune_nom = match.commune_nom;
      }
    }

    return NextResponse.json({
      extraction: parsed.data,
      file_path: storagePath,
      suggested_commune_id,
      suggested_commune_nom,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erreur OCR inconnue.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
