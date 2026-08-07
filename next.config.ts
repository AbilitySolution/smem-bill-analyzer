import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Next 16 : le proxy (proxy.ts) mémorise le corps de chaque requête pour
    // pouvoir le relire, plafonné par défaut à 10 Mo — non configuré jusqu'ici.
    // L'import en lot envoie des multiparts jusqu'à MAX_REQUEST_BYTES
    // (lib/documents/queue.ts, 40 Mo) : au-delà de 10 Mo, le corps était
    // tronqué/rejeté avant d'atteindre app/api/document-jobs/route.ts, avec un
    // 413 sur les lots les plus lourds — symptôme observé : sur un dépôt de 72
    // fichiers, seuls les lots restés sous 10 Mo passaient (52/72).
    // Marge au-delà de 40 Mo pour l'enveloppe multipart (limites de parties,
    // en-têtes) qui gonfle légèrement la taille réelle envoyée par le navigateur.
    proxyClientMaxBodySize: "48mb",
  },
};

export default nextConfig;
