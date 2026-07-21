// TEMP — vérification visuelle (hors auth). À supprimer après contrôle.
import UploadPage from "@/app/(app)/upload/page";

export default function PreviewUploadPage() {
  return (
    <div className="min-h-screen bg-[var(--kn-page)] text-[var(--kn-text)]">
      <UploadPage />
    </div>
  );
}
