import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAnthropicClient, OCR_MODEL } from "@/lib/anthropic/client";
import {
  invoiceExtractionSchema,
  invoiceExtractionToolSchema,
} from "@/lib/anthropic/invoice-schema";
import { validateInvoice } from "@/lib/anthropic/invoice-validation";

const EXTRACTION_PROMPT = `Tu analyses une facture EDF (électricité) d'un bâtiment public ou d'un point d'éclairage public. Extrait toutes les données structurées en utilisant l'outil extract_edf_invoice.

Règles importantes :
- Toutes les dates au format ISO 8601 (YYYY-MM-DD).
- Les montants en nombres (pas de texte, pas de symbole €), point comme séparateur décimal.
- tarif_type : normaliser en "BASE" (tarif unique), "HPHC" (heures pleines/creuses), "TEMPO" (bleu/blanc/rouge), "EJP". Déduire depuis l'offre ou le service. Si indéterminable, null.
- Les lignes "part fixe / abonnement" vont dans fixed_charges.
- Les lignes "part variable" avec index ancien/nouveau de compteur vont dans consumption_lines.
- NE PAS inclure le tableau "historique de consommation" (résumé hp/hc/base sur plusieurs années/périodes passées).
- poste_tarifaire normalisé : HP, HC, BASE, TEMPO_HP, TEMPO_HC, EJP_HP, EJP_HPN.
- Si la période courante n'a qu'un seul poste sans distinction HP/HC (libellé "consommations", "base" ou vide) → poste_tarifaire = "BASE".
- Si la consommation BASE est découpée en sous-périodes par changement de barème (ex. "consommations - barème du 07/05/2023 au 31/07/2023" et "consommations - barème du 01/08/2023 au 07/11/2023") → créer UNE ligne par sous-période : poste_tarifaire="BASE", dates de la sous-période, prix unitaire et montant de chaque sous-période. Ignorer la ligne de total "consommations" globale si les sous-lignes barème sont présentes.
- Si HP et HC coexistent dans la partie variable → une ligne par poste.
- Toutes les lignes "Taxes et contributions" vont dans taxes, une par taxe/période. taux_unit = "eur_per_kwh" si en €/kWh, "percent" si en %.
- Si une valeur absente : null (jamais d'invention).
- is_duplicata = true si le mot "DUPLICATA" apparaît.
- commune_hint : nom de la commune tel qu'il apparaît sur la facture (adresse client, espace de livraison, ou en-tête). Copier le texte brut trouvé sur la facture sans normaliser. Null si absent.
- precision : score 0-1 pour chaque champ clé (1 = parfaitement lisible ; plus bas si flou, ambigu, déduit ou absent). Couvrir : facture_number, facture_date, total_ht, tva, autres_taxes, total_ttc, contract_number, puissance_souscrite_kva.`;

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

    // Match commune_hint against canonical list with abbreviation normalization
    let suggested_commune_id: string | null = null;
    let suggested_commune_nom: string | null = null;
    // Build candidate texts to search for commune: hint → espace_livraison → adresse
    const hintCandidates = [
      parsed.data.commune_hint,
      parsed.data.contract.espace_livraison,
      parsed.data.client.adresse,
      parsed.data.client.nom,
    ].filter(Boolean) as string[];

    if (hintCandidates.length) {
      const { data: allCommunes } = await supabase.from("communes").select("id, nom");
      if (allCommunes?.length) {
        // Normalize: expand abbrevs, neutralize saint/sainte gender, strip accents/punct
        const COMM_STOP = new Set(["de", "du", "la", "le", "les", "des", "l", "d", "en", "et", "a", "au"]);
        const normalizeComm = (s: string) =>
          s.toLowerCase()
            .normalize("NFD").replace(/\p{Mn}/gu, "")
            .replace(/\bste\b/g, "sainte")
            .replace(/\bst\b/g, "saint")
            .replace(/\bsainte\b/g, "saint") // neutralize gender: saint == sainte
            .replace(/\bgde?\b/g, "grand")
            .replace(/\bgrande\b/g, "grand")
            .replace(/[^a-z0-9 ]/g, " ")
            .replace(/\s+/g, " ").trim();

        const meaningfulWords = (normalized: string) =>
          normalized.split(" ").filter((w) => w.length > 1 && !COMM_STOP.has(w));

        const scoreOne = (candidate: string, communeNom: string) => {
          const nc = normalizeComm(candidate);
          const nn = normalizeComm(communeNom);
          // Exact / substring match
          if (nc === nn || nc.includes(nn) || nn.includes(nc)) return 100;
          // Word-overlap on meaningful words only (ignore stop words)
          const cWords = new Set(meaningfulWords(nc));
          const nWords = meaningfulWords(nn);
          if (nWords.length === 0) return 0;
          const matches = nWords.filter((w) => cWords.has(w)).length;
          return matches / nWords.length;
        };

        let bestScore = 0;
        let best: { id: string; nom: string } | null = null;
        for (const c of allCommunes) {
          const s = Math.max(...hintCandidates.map((h) => scoreOne(h, c.nom)));
          if (s > bestScore) { bestScore = s; best = c; }
        }
        if (best && bestScore >= 0.5) {
          suggested_commune_id = best.id;
          suggested_commune_nom = best.nom;
        }
      }
    }

    // Lookup existing site by contract_number within the matched commune
    let suggested_site_id: string | null = null;
    let suggested_site_nom: string | null = null;
    const contractNumber = parsed.data.contract.contract_number;
    if (suggested_commune_id && contractNumber) {
      const { data: existingContract } = await supabase
        .from("contracts")
        .select("site_id, sites(id, nom, commune_id)")
        .eq("contract_number", contractNumber)
        .maybeSingle();
      const rawSite = existingContract?.sites;
      const contractSite = Array.isArray(rawSite) ? rawSite[0] : rawSite;
      if (contractSite && (contractSite as { commune_id: string }).commune_id === suggested_commune_id) {
        suggested_site_id = (contractSite as { id: string }).id;
        suggested_site_nom = (contractSite as { nom: string }).nom;
      }
    }

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
