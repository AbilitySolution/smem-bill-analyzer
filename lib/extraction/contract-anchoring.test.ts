import { describe, it, expect } from "vitest";
import { checkContractAnchoring, type StoredContractProfile } from "./contract-anchoring";
import type { InvoiceExtraction } from "@/lib/anthropic/invoice-schema";

function extraction(contract: Partial<InvoiceExtraction["contract"]> = {}): InvoiceExtraction {
  return {
    client: { nom: "Commune de Test", reference_client: null, reference_compte: null, adresse: null },
    contract: {
      contract_number: "12345678901234", tarif_type: "HPHC", espace_livraison: null, offre: null,
      service: null, puissance_souscrite_kva: 36, reglage_protection_a: null, type_compteur: null,
      numero_compteur: null, ...contract,
    },
    invoice: {
      facture_number: "F-2026-002", facture_date: "2026-03-01", date_limite_paiement: null,
      date_prochain_releve: null, date_prochaine_facture: null, total_ht: 100, tva: 5.4,
      autres_taxes: 2.5, total_ttc: 107.9, is_duplicata: false,
    },
    commune_hint: null, categorie_hint: null,
    fixed_charges: [], consumption_lines: [], taxes: [], precision: {},
  };
}

const profile = (o: Partial<StoredContractProfile> = {}): StoredContractProfile => ({
  contract_number: "12345678901234",
  tarif_type: "HPHC",
  puissance_souscrite_kva: 36,
  invoiceCount: 12,
  ...o,
});

describe("checkContractAnchoring", () => {
  it("lecture conforme à l'historique -> silence", () => {
    expect(checkContractAnchoring(extraction(), profile())).toHaveLength(0);
  });

  it("pas d'historique -> silence", () => {
    expect(checkContractAnchoring(extraction(), null)).toHaveLength(0);
  });

  // Une seule facture antérieure ne prouve rien : elle a pu être extraite de travers.
  it("historique trop court -> silence", () => {
    const issues = checkContractAnchoring(extraction({ tarif_type: "BASE" }), profile({ invoiceCount: 1 }));
    expect(issues).toHaveLength(0);
  });

  it("tarif_type divergent -> conflit signalé", () => {
    const issues = checkContractAnchoring(extraction({ tarif_type: "BASE" }), profile());
    expect(issues[0].code).toBe("CONTRACT_ANCHOR_CONFLICT");
    expect(issues[0].message).toContain("HPHC");
  });

  it("tarif_type non déduit alors que l'historique le connaît -> trou comblable", () => {
    const issues = checkContractAnchoring(extraction({ tarif_type: null }), profile());
    expect(issues[0].code).toBe("CONTRACT_ANCHOR_MISSING");
  });

  // Une puissance se renégocie par paliers francs ; un écart d'un dixième trahit la lecture.
  it("écart de puissance sous le seuil relatif -> toléré", () => {
    expect(
      checkContractAnchoring(extraction({ puissance_souscrite_kva: 36.5 }), profile()),
    ).toHaveLength(0);
  });

  it("changement de palier de puissance -> signalé", () => {
    const issues = checkContractAnchoring(extraction({ puissance_souscrite_kva: 18 }), profile());
    expect(issues.some((i) => i.field === "contract.puissance_souscrite_kva")).toBe(true);
    expect(issues.find((i) => i.field === "contract.puissance_souscrite_kva")?.delta).toBe(-18);
  });

  it("aucune valeur en historique -> rien à ancrer", () => {
    const issues = checkContractAnchoring(
      extraction({ tarif_type: "BASE", puissance_souscrite_kva: 6 }),
      profile({ tarif_type: null, puissance_souscrite_kva: null }),
    );
    expect(issues).toHaveLength(0);
  });
});
