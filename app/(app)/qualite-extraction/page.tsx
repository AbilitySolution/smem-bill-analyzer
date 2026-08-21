import { redirect } from "next/navigation";

// « Qualité d'extraction » est désormais un onglet de la page Documentation.
export default function QualiteExtractionRedirect() {
  redirect("/documentation/qualite");
}
