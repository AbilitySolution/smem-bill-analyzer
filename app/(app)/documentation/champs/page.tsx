import { requireRole } from "@/lib/auth-guard";
import { Info } from "lucide-react";

const GROUPS: { titre: string; champs: { nom: string; type: string; desc: string }[] }[] = [
  {
    titre: "Facture",
    champs: [
      { nom: "Numéro de facture", type: "Code", desc: "Identifiant unique de la facture (facture_number)." },
      { nom: "Date de facture", type: "Date", desc: "Date d'émission (facture_date)." },
      { nom: "Date limite de paiement", type: "Date", desc: "Échéance de règlement (date_limite_paiement)." },
      { nom: "Date prochain relevé", type: "Date", desc: "Date du prochain relevé de compteur (date_prochain_releve)." },
      { nom: "Date prochaine facture", type: "Date", desc: "Date estimée de la prochaine facture (date_prochaine_facture)." },
      { nom: "Total HT", type: "Nombre €", desc: "Montant hors taxes (total_ht)." },
      { nom: "TVA", type: "Nombre €", desc: "Montant de TVA (tva)." },
      { nom: "Autres taxes", type: "Nombre €", desc: "Total des autres taxes (autres_taxes)." },
      { nom: "Total TTC", type: "Nombre €", desc: "Montant toutes taxes comprises (total_ttc)." },
      { nom: "Catégorie", type: "Enum", desc: "batiment ou eclairage_public (categorie)." },
      { nom: "Duplicata", type: "Booléen", desc: "Vrai si « DUPLICATA » figure sur le document (is_duplicata)." },
    ],
  },
  {
    titre: "Client",
    champs: [
      { nom: "Nom du client", type: "Texte", desc: "Raison sociale du destinataire (clients.nom)." },
      { nom: "Référence client", type: "Code", desc: "Numéro client EDF/Enedis (clients.reference_client)." },
      { nom: "Référence compte", type: "Code", desc: "Numéro de compte (clients.reference_compte)." },
      { nom: "Adresse", type: "Texte", desc: "Adresse postale du client (clients.adresse)." },
    ],
  },
  {
    titre: "Contrat",
    champs: [
      { nom: "Numéro de contrat", type: "Code", desc: "Identifiant du contrat de fourniture (contracts.contract_number)." },
      { nom: "Type tarifaire", type: "Enum", desc: "BASE, HPHC, TEMPO ou EJP (contracts.tarif_type)." },
      { nom: "Offre", type: "Texte", desc: "Nom commercial de l'offre (contracts.offre)." },
      { nom: "Service", type: "Texte", desc: "Type de service souscrit (contracts.service)." },
      { nom: "Espace de livraison", type: "Texte", desc: "Libellé du lieu de livraison (contracts.espace_livraison)." },
      { nom: "Puissance souscrite (kVA)", type: "Nombre", desc: "Puissance du contrat (contracts.puissance_souscrite_kva)." },
      { nom: "Réglage protection (A)", type: "Nombre", desc: "Calibre du disjoncteur (contracts.reglage_protection_a)." },
      { nom: "Type compteur", type: "Texte", desc: "Modèle ou type du compteur (contracts.type_compteur)." },
      { nom: "Numéro compteur", type: "Code", desc: "Numéro de série du compteur (contracts.numero_compteur)." },
    ],
  },
  {
    titre: "Site / point de livraison",
    champs: [
      { nom: "Nom du site", type: "Texte", desc: "Nom du bâtiment ou point d'éclairage (sites.nom)." },
      { nom: "Puissance (kVA)", type: "Nombre", desc: "Puissance souscrite au niveau du site (sites.kva)." },
      { nom: "Calibre (A)", type: "Nombre", desc: "Ampérage du disjoncteur (sites.ampere)." },
      { nom: "Catégorie", type: "Enum", desc: "batiment ou eclairage_public (sites.categorie)." },
    ],
  },
  {
    titre: "Lignes de consommation (répétées)",
    champs: [
      { nom: "Poste tarifaire", type: "Texte", desc: "HP, HC, Base, TEMPO_HP, TEMPO_HC, EJP_HP… (consumption_periods.poste_tarifaire)." },
      { nom: "Période début / fin", type: "Date", desc: "Dates de la période relevée (period_start / period_end)." },
      { nom: "Numéro compteur", type: "Code", desc: "N° de compteur de la ligne (consumption_periods.numero_compteur)." },
      { nom: "Ancien index", type: "Nombre", desc: "Index de début de période (ancien_index)." },
      { nom: "Nouvel index", type: "Nombre", desc: "Index de fin de période (nouveau_index)." },
      { nom: "Coefficient", type: "Nombre", desc: "Coefficient multiplicateur du compteur (coefficient)." },
      { nom: "Consommation (kWh)", type: "Nombre", desc: "Énergie consommée sur la période (consommation_kwh)." },
      { nom: "Prix unitaire (c€/kWh)", type: "Nombre", desc: "Tarif appliqué à la ligne (prix_unitaire_ckwh)." },
      { nom: "Montant (€)", type: "Nombre €", desc: "Montant de la ligne de consommation (montant_eur)." },
      { nom: "Index estimé", type: "Booléen", desc: "Vrai si l'index est une estimation EDF (index_estime)." },
    ],
  },
  {
    titre: "Taxes & part fixe (répétées)",
    champs: [
      { nom: "Libellé", type: "Texte", desc: "Intitulé de la taxe ou de l'abonnement (invoice_charges.libelle)." },
      { nom: "Type", type: "Enum", desc: "fixed (abonnement/part fixe) ou tax (taxe) (invoice_charges.category)." },
      { nom: "Période début / fin", type: "Date", desc: "Dates couvertes par la charge (period_start / period_end)." },
      { nom: "Assiette", type: "Nombre", desc: "Base de calcul de la taxe (assiette)." },
      { nom: "Taux", type: "Texte", desc: "Taux brut tel qu'affiché sur la facture (taux)." },
      { nom: "Unité du taux", type: "Enum", desc: "eur_per_kwh ou percent (taux_unit)." },
      { nom: "Tarif kVA/an", type: "Nombre €", desc: "Tarif d'abonnement en €/kVA/an pour la part fixe (tarif_kva_an)." },
      { nom: "Montant (€)", type: "Nombre €", desc: "Montant de la ligne (montant_eur)." },
    ],
  },
];

export default async function DocumentationChampsPage() {
  await requireRole("org_supervisor");

  return (
    <div className="mx-auto max-w-4xl px-8 py-6">
      <div className="mb-5 flex items-start gap-2.5 rounded-xl border border-[#fed7aa] bg-[var(--kn-yellow-soft)] px-4 py-3">
        <Info className="mt-0.5 size-4 shrink-0 text-[#ea580c]" />
        <p className="text-[13px] text-[var(--kn-text)]">
          Le modèle unique « Facture d&apos;électricité » extrait automatiquement les champs ci-dessous via l&apos;<strong>OCR</strong>.
          Les noms entre parenthèses correspondent aux colonnes de la base de données.
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
