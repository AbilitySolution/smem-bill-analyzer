import { redirect } from "next/navigation";

// Ancienne route — conservée en redirection vers le hub « Mes documents ».
export default function FacturesPage() {
  redirect("/documents");
}
