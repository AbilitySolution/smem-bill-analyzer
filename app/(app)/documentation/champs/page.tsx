import { Info } from "lucide-react";

// Champs du modèle d'extraction unique (reflète lib/anthropic/invoice-schema.ts).
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

export default function DocumentationChampsPage() {
  return (
    <div className="mx-auto max-w-4xl px-8 py-6">
      <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-[#fed7aa] bg-[var(--kn-yellow-soft)] px-4 py-3">
        <Info className="mt-0.5 size-4 shrink-0 text-[#ea580c]" />
        <p className="text-[13px] text-[var(--kn-text)]">
          Le modèle unique « Facture d&apos;électricité » extrait automatiquement les champs ci-dessous via l&apos;<strong>OCR</strong>.
          L&apos;édition des libellés <strong>et la personnalisation des champs</strong> sera disponible prochainement.
        </p>
      </div>

      <div className="space-y-5">
        {GROUPS.map((g) => (
          <div key={g.titre} className="rounded-xl border border-[var(--kn-border)] bg-[var(--kn-card)]">
            <div className="border-b border-[var(--kn-border)] px-4 py-2.5">
              <h2 className="font-heading text-[15px] font-semibold text-[var(--kn-text)]">{g.titre}</h2>
            </div>
            <div className="divide-y divide-[var(--kn-border)]">
              {g.champs.map((c) => (
                <div key={c.nom} className="flex items-start gap-4 px-4 py-2.5">
                  <span className="kn-type shrink-0">{c.type}</span>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-[var(--kn-text)]">{c.nom}</p>
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
