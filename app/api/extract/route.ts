import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAnthropicClient, OCR_MODEL, retryWithBackoff } from "@/lib/anthropic/client";
import {
  invoiceExtractionSchema,
  invoiceExtractionToolSchema,
} from "@/lib/anthropic/invoice-schema";
import { validateInvoice } from "@/lib/anthropic/invoice-validation";
import { matchCommune } from "@/lib/invoices/commune-match";

// Règles générales déplacées en system prompt : plus stables, moins sensibles aux variations de mise en page.
const SYSTEM_PROMPT = `Tu es un assistant spécialisé dans l'extraction de données de factures EDF (électricité) pour des bâtiments publics et points d'éclairage public en France.

Règles générales :
- Toutes les dates au format ISO 8601 (YYYY-MM-DD).
- Les montants en nombre décimal avec point comme séparateur (ex. 123.45), sans symbole €.
- Si une valeur est absente ou illisible : null — ne jamais inventer.
- Codes poste_tarifaire canoniques : HP, HC, BASE, HPB, HCB, HPW, HCW, HPR, HCR, EJPN, EJPP.
  Même si la facture écrit "Heure P", "Heures Pleines", "H.P." → utiliser "HP". Idem pour HC et les variantes TEMPO.
- Sur contrat HPHC, HP (heures pleines) est TOUJOURS plus cher que HC (heures creuses). Si tu lis le même prix pour HP et HC dans la même période, relis attentivement la facture.
- precision : donner un score 0-1 pour chaque champ clé (1 = parfaitement lisible ; plus bas si flou, ambigu, déduit ou absent).`;

// Instructions structurelles EDF dans le message user (contexte document spécifique à chaque facture).
const EXTRACTION_PROMPT = `Extrait toutes les données structurées de cette facture EDF en utilisant l'outil extract_edf_invoice.

Structure EDF :
- "Part fixe / abonnement" → fixed_charges (une ligne par poste).
- "Part variable / consommation" avec anciens/nouveaux index → consumption_lines (PÉRIODE COURANTE uniquement).
- NE PAS inclure le tableau "historique de consommation" (résumé hp/hc/base sur plusieurs années passées).
- "Taxes et contributions" → taxes, une ligne par taxe/période. taux_unit = "eur_per_kwh" si en €/kWh, "percent" si en %.

Règles consommation :
- Un seul poste sans HP/HC → poste_tarifaire = "BASE".
- HP et HC coexistent → une ligne par poste.
- Consommation BASE découpée par barème (ex. "barème du 01/07 au 31/07" et "barème du 01/08 au…") → UNE ligne par sous-période, poste_tarifaire="BASE", dates et prix du barème. Ignorer la ligne totale globale.
- tarif_type : "BASE", "HPHC", "TEMPO", "EJP" déduit depuis l'offre ou le service. Null si indéterminable.

Autres :
- is_duplicata = true si le mot "DUPLICATA" apparaît.
- commune_hint : nom de commune tel qu'il apparaît sur la facture (adresse client, espace de livraison, en-tête). Texte brut sans normaliser. Null si absent.`;

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
      return NextResponse.json({ error: "Claude n'a pas retourné d'extraction." }, { status: 502 });
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
    const message = err instanceof Error ? err.message : "Erreur OCR inconnue.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
