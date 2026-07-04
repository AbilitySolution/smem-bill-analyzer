export type InvoiceStatus = "pending_review" | "reviewed" | "anomaly_flagged";
export type AnomalyType =
  | "consumption_spike"
  | "missing_period"
  | "amount_mismatch"
  | "tariff_change";
export type AnomalySeverity = "low" | "medium" | "high";
export type TauxUnit = "eur_per_kwh" | "percent";
export type ChargeCategory = "fixed" | "tax";

export interface Client {
  id: string;
  nom: string;
  reference_client: string | null;
  reference_compte: string | null;
  adresse: string | null;
  created_at: string;
}

export interface Contract {
  id: string;
  client_id: string | null;
  contract_number: string;
  espace_livraison: string | null;
  offre: string | null;
  service: string | null;
  puissance_souscrite_kva: number | null;
  reglage_protection_a: number | null;
  type_compteur: string | null;
  numero_compteur: string | null;
  created_at: string;
}

export interface Invoice {
  id: string;
  contract_id: string | null;
  client_id: string | null;
  facture_number: string;
  facture_date: string;
  date_limite_paiement: string | null;
  date_prochain_releve: string | null;
  date_prochaine_facture: string | null;
  total_ht: number;
  tva: number | null;
  autres_taxes: number | null;
  total_ttc: number;
  is_duplicata: boolean;
  raw_ocr_json: unknown;
  file_path: string;
  status: InvoiceStatus;
  created_by: string | null;
  created_at: string;
}

// Fact table: one row per billed consumption period. This is the single
// source for time-series charts and anomaly detection — query by
// contract_id + period_start, no joins needed.
export interface ConsumptionPeriod {
  id: string;
  invoice_id: string;
  contract_id: string | null;
  poste_tarifaire: string;
  period_start: string | null;
  period_end: string | null;
  numero_compteur: string | null;
  ancien_index: number | null;
  nouveau_index: number | null;
  coefficient: number;
  consommation_kwh: number;
  prix_unitaire_ckwh: number | null;
  montant_eur: number;
  index_estime: boolean;
}

// Billing detail: fixed charges + taxes, same shape (labeled line, period,
// amount). Used for invoice display/audit, not for analytics.
export interface InvoiceCharge {
  id: string;
  invoice_id: string;
  category: ChargeCategory;
  libelle: string;
  period_start: string | null;
  period_end: string | null;
  assiette: number | null;
  taux: string | null;
  taux_numeric: number | null;
  taux_unit: TauxUnit | null;
  montant_eur: number;
}

export interface CorrectionLog {
  id: string;
  invoice_id: string;
  table_name: string;
  row_id: string | null;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  corrected_by: string | null;
  corrected_at: string;
}

export interface Anomaly {
  id: string;
  contract_id: string | null;
  consumption_period_id: string | null;
  invoice_id: string | null;
  type: AnomalyType;
  severity: AnomalySeverity;
  description: string | null;
  detected_value: number | null;
  expected_range_min: number | null;
  expected_range_max: number | null;
  detected_at: string;
  resolved: boolean;
}
