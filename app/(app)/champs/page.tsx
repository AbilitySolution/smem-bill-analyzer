import { SlidersHorizontal } from "lucide-react";

// Champs du modèle d'extraction unique (reflète lib/anthropic/invoice-schema.ts).
// Lecture seule pour l'instant ; l'édition arrive en Phase 5.
const GROUPS: { titre: string; champs: { nom: string; type: string; desc: string }[] }[] = [
  {
    titre: "Facture",
    champs: [
      { nom: "Numéro de facture", type: "Code", desc: "Identifiant unique de la facture." },
      { nom: "Date de facture", type: "Date", desc: "Date d'émission." },
      { nom: "Date limite de paiement", type: "Date", desc: "Échéance de règlement." },
      { nom: "Total HT", type: "Nombre", desc: "Montant hors taxes." },
      { nom: "TVA", type: "Nombre", desc: "Montant de TVA." },
      { nom: "Autres taxes", type: "Nombre", desc: "Total des autres taxes." },
      { nom: "Total TTC", type: "Nombre", desc: "Montant toutes taxes comprises." },
      { nom: "Duplicata", type: "Booléen", desc: "Vrai si « DUPLICATA » figure sur le document." },
    ],
  },
  {
    titre: "Client & contrat",
    champs: [
      { nom: "Nom du client", type: "Texte", desc: "Raison sociale du destinataire." },
      { nom: "Référence client / compte", type: "Code", desc: "Références sur la facture." },
      { nom: "Numéro de contrat", type: "Code", desc: "Identifiant du contrat de fourniture." },
      { nom: "Puissance souscrite (kVA)", type: "Nombre", desc: "Puissance du contrat." },
      { nom: "Numéro de compteur / PDL", type: "Code", desc: "Point de livraison." },
    ],
  },
  {
    titre: "Lignes de consommation (répété)",
    champs: [
      { nom: "Poste tarifaire", type: "Texte", desc: "Heures pleines / creuses / base…" },
      { nom: "Période", type: "Date", desc: "Début et fin de période." },
      { nom: "Index ancien / nouveau", type: "Nombre", desc: "Relevés de compteur." },
      { nom: "Consommation (kWh)", type: "Nombre", desc: "Énergie consommée." },
      { nom: "Prix unitaire (c€/kWh)", type: "Nombre", desc: "Tarif appliqué." },
      { nom: "Montant (€)", type: "Nombre", desc: "Montant de la ligne." },
    ],
  },
  {
    titre: "Taxes & part fixe (répété)",
    champs: [
      { nom: "Libellé", type: "Texte", desc: "Intitulé de la taxe ou de l'abonnement." },
      { nom: "Assiette / taux", type: "Nombre", desc: "Base et taux appliqués." },
      { nom: "Montant (€)", type: "Nombre", desc: "Montant de la ligne." },
    ],
  },
];

export default function ChampsPage() {
  return (
    <div className="mx-auto max-w-4xl px-8 py-6">
      <div className="mb-1 flex items-center gap-2.5">
        <SlidersHorizontal className="size-6 text-[#1a1a1a]" strokeWidth={1.75} />
        <h1 className="font-heading text-2xl font-bold text-[#1a1a1a]">Champs d&apos;extraction</h1>
      </div>
      <p className="mb-6 text-[13px] text-[var(--kn-text-muted)]">
        Le modèle unique « Facture d&apos;électricité » extrait automatiquement les champs ci-dessous via l&apos;IA.
        L&apos;édition des libellés et consignes sera disponible prochainement.
      </p>

      <div className="space-y-5">
        {GROUPS.map((g) => (
          <div key={g.titre} className="rounded-xl border border-[var(--kn-border)] bg-white">
            <div className="border-b border-[var(--kn-border)] px-4 py-2.5">
              <h2 className="font-heading text-[15px] font-semibold text-[#1a1a1a]">{g.titre}</h2>
            </div>
            <div className="divide-y divide-[var(--kn-border)]">
              {g.champs.map((c) => (
                <div key={c.nom} className="flex items-start gap-4 px-4 py-2.5">
                  <span className="kn-type shrink-0">{c.type}</span>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[#1a1a1a]">{c.nom}</p>
                    <p className="text-[12px] text-[var(--kn-text-muted)]">{c.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
