import { describe, it, expect } from "vitest";
import {
  ROLE_LEVEL,
  ROLE_LABELS,
  ROUTE_RULES,
  hasAtLeast,
  isUserRole,
  requiredRoleFor,
  estLectureOuverte,
} from "./authz";
import type { UserRole } from "@/lib/types/database";

const ROLES: UserRole[] = ["org_member", "org_supervisor", "org_admin"];

describe("hiérarchie des rôles", () => {
  it("chaque rôle se satisfait lui-même", () => {
    for (const role of ROLES) expect(hasAtLeast(role, role)).toBe(true);
  });

  it("un admin peut tout ce que peuvent superviseur et membre", () => {
    expect(hasAtLeast("org_admin", "org_supervisor")).toBe(true);
    expect(hasAtLeast("org_admin", "org_member")).toBe(true);
  });

  it("un superviseur couvre le membre mais pas l'admin", () => {
    expect(hasAtLeast("org_supervisor", "org_member")).toBe(true);
    expect(hasAtLeast("org_supervisor", "org_admin")).toBe(false);
  });

  it("un membre ne couvre ni superviseur ni admin", () => {
    expect(hasAtLeast("org_member", "org_supervisor")).toBe(false);
    expect(hasAtLeast("org_member", "org_admin")).toBe(false);
  });

  it("les niveaux sont strictement ordonnés — le classement ne doit jamais devenir ambigu", () => {
    expect(ROLE_LEVEL.org_member).toBeLessThan(ROLE_LEVEL.org_supervisor);
    expect(ROLE_LEVEL.org_supervisor).toBeLessThan(ROLE_LEVEL.org_admin);
  });

  it("chaque rôle a un libellé français", () => {
    for (const role of ROLES) expect(ROLE_LABELS[role]).toBeTruthy();
  });
});

describe("isUserRole", () => {
  it("accepte les trois rôles connus", () => {
    for (const role of ROLES) expect(isUserRole(role)).toBe(true);
  });

  it("refuse une valeur inconnue ou absente venue de la base", () => {
    expect(isUserRole("admin_smem")).toBe(false); // ancien rôle d'avant le multi-tenant
    expect(isUserRole(null)).toBe(false);
    expect(isUserRole(undefined)).toBe(false);
  });
});

describe("requiredRoleFor — chaque ligne de la matrice", () => {
  const attendus: [string, UserRole | null][] = [
    ["/parametres", "org_admin"],
    ["/parametres/demandes", "org_admin"],
    ["/champs", "org_admin"],
    ["/connecteurs", "org_admin"],
    ["/api/custom-fields", "org_admin"],
    ["/qualite-extraction", "org_supervisor"],
    ["/corrections", "org_supervisor"],
    ["/documents/extraction", "org_supervisor"],
    ["/exploitation", "org_supervisor"],
    ["/documentation", "org_supervisor"],
    ["/documentation/champs", "org_supervisor"],
    ["/api/export/extraction", "org_supervisor"],
    // Ouvert à tout utilisateur authentifié.
    ["/upload", null],
    ["/upload/review", null],
    ["/documents", null],
    ["/documents/export", null],
    ["/factures", null],
    ["/factures/abc-123", null],
    ["/analyses/consommation", null],
    ["/analyses/couverture", null],
    ["/rapport-excel", null],
    ["/anomalies", null],
    ["/api/invoices", null],
    ["/api/export/invoices", null],
  ];

  for (const [chemin, attendu] of attendus) {
    it(`${chemin} -> ${attendu ?? "authentifié"}`, () => {
      expect(requiredRoleFor(chemin)).toBe(attendu);
    });
  }

  it("toute règle déclarée est effectivement appliquée à son propre préfixe", () => {
    for (const rule of ROUTE_RULES) {
      expect(requiredRoleFor(rule.prefix)).toBe(rule.role);
    }
  });
});

describe("requiredRoleFor — ordre et correspondance sur segment complet", () => {
  it("/documents/extraction est testé avant tout préfixe /documents", () => {
    const iExtraction = ROUTE_RULES.findIndex((r) => r.prefix === "/documents/extraction");
    const iDocuments = ROUTE_RULES.findIndex((r) => r.prefix === "/documents");
    expect(iExtraction).toBeGreaterThanOrEqual(0);
    // Tant que /documents n'est pas une règle, la question ne se pose pas ; si elle
    // apparaît un jour, elle doit venir après.
    if (iDocuments >= 0) expect(iExtraction).toBeLessThan(iDocuments);
    expect(requiredRoleFor("/documents/extraction/en-cours")).toBe("org_supervisor");
    expect(requiredRoleFor("/documents/export")).toBeNull();
  });

  it("un préfixe ne capture pas un chemin qui ne fait que commencer par ses lettres", () => {
    expect(requiredRoleFor("/champs-personnalises")).toBeNull();
    expect(requiredRoleFor("/parametrage")).toBeNull();
    expect(requiredRoleFor("/documentation-interne")).toBeNull();
    expect(requiredRoleFor("/api/custom-fields-legacy")).toBeNull();
  });

  it("les sous-chemins héritent de la règle du parent", () => {
    expect(requiredRoleFor("/parametres/demandes/42")).toBe("org_admin");
    expect(requiredRoleFor("/qualite-extraction/details")).toBe("org_supervisor");
  });

  it("la barre oblique finale ne change pas la décision", () => {
    expect(requiredRoleFor("/parametres/")).toBe("org_admin");
    expect(requiredRoleFor("/")).toBeNull();
  });
});

describe("estLectureOuverte", () => {
  it("la lecture des champs personnalisés reste ouverte — /upload/review en dépend", () => {
    expect(estLectureOuverte("/api/custom-fields", "GET")).toBe(true);
    expect(estLectureOuverte("/api/custom-fields", "HEAD")).toBe(true);
  });

  it("une écriture sur la même route reste soumise à la matrice", () => {
    expect(estLectureOuverte("/api/custom-fields", "POST")).toBe(false);
    expect(estLectureOuverte("/api/custom-fields", "DELETE")).toBe(false);
  });

  it("aucune autre route réservée n'est exemptée", () => {
    expect(estLectureOuverte("/api/export/extraction", "GET")).toBe(false);
    expect(estLectureOuverte("/parametres", "GET")).toBe(false);
  });
});
