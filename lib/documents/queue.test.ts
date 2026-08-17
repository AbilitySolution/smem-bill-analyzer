import { describe, it, expect } from "vitest";
import {
  DIRECT_DOCUMENT_LIMIT,
  DIRECT_JOBS_PER_INVOCATION,
  MAX_FILES_PER_REQUEST,
  chunkForUpload,
  processingModeFor,
} from "./queue";

describe("processingModeFor", () => {
  it("envoie les petits dépôts en direct", () => {
    // Attendre trois minutes pour économiser quelques centimes n'a pas de sens :
    // sous le seuil, la latence prime sur le coût.
    expect(processingModeFor(1)).toBe("direct");
    expect(processingModeFor(DIRECT_DOCUMENT_LIMIT)).toBe("direct");
  });

  it("bascule en batch dès le premier document au-dessus du seuil", () => {
    expect(processingModeFor(DIRECT_DOCUMENT_LIMIT + 1)).toBe("batch");
    expect(processingModeFor(100)).toBe("batch");
  });

  it("garde les gros dépôts en batch — c'est là qu'est l'économie", () => {
    // Cas réels observés en production : lots de 42 à 105 documents.
    for (const size of [42, 50, 63, 105]) {
      expect(processingModeFor(size)).toBe("batch");
    }
  });

  it("laisse un dépôt direct absorbable en une seule invocation du worker", () => {
    // Sinon un petit dépôt attendrait un second tour de worker, ce qui annulerait
    // l'intérêt même de ce mode.
    expect(DIRECT_DOCUMENT_LIMIT).toBeLessThanOrEqual(DIRECT_JOBS_PER_INVOCATION);
  });
});

describe("chunkForUpload", () => {
  it("laisse un petit dépôt en un seul envoi", () => {
    expect(chunkForUpload([1, 2, 3])).toEqual([[1, 2, 3]]);
  });

  it("découpe au plafond par requête", () => {
    const items = Array.from({ length: MAX_FILES_PER_REQUEST * 2 + 1 }, (_, i) => i);
    const chunks = chunkForUpload(items);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(MAX_FILES_PER_REQUEST);
    expect(chunks.at(-1)).toHaveLength(1);
    expect(chunks.flat()).toEqual(items);
  });

  it("ne renvoie rien pour une sélection vide", () => {
    expect(chunkForUpload([])).toEqual([]);
  });
});
