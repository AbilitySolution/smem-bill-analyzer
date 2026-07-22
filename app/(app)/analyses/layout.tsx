import { AnalysesNavigation } from "@/components/analyses/analyses-navigation";

export default function AnalysesLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AnalysesNavigation />
      {children}
    </>
  );
}
