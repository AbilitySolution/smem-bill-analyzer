import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Next 16 : le proxy (proxy.ts) mémorise le corps de chaque requête pour
    // pouvoir le relire, plafonné par défaut à 10 Mo.
    //
    // Historique : ce réglage a été monté à 90 Mo pour laisser passer l'upload en lot
    // de factures en multipart — corrigeait bien un premier symptôme (413 sur un gros
    // dépôt), mais sur de mauvaises bases. La vraie limite qui a fini par mordre est
    // celle des Vercel Functions elles-mêmes : 4,5 Mo de corps de requête ENTRANT,
    // fixe, non configurable (`FUNCTION_PAYLOAD_TOO_LARGE`, vérifié sur la doc Vercel).
    // Ce réglage-ci est une couche AU-DESSUS de cette limite, donc incapable de la
    // dépasser quelle que soit sa valeur — le vrai fix a été de sortir les octets des
    // fichiers de cette route (dépôt direct navigateur → Supabase Storage, voir
    // lib/documents/queue.ts). `POST /api/document-jobs` ne reçoit plus que des lots de
    // métadonnées JSON, largement sous le défaut de 10 Mo — cette valeur n'a donc plus
    // besoin d'être relevée, gardée à titre de marge pour d'éventuels gros lots de
    // métadonnées (des milliers de fichiers en un seul lot, cas non atteint en pratique
    // vu `MAX_FILES_PER_REQUEST`).
    proxyClientMaxBodySize: "4mb",
  },
};

export default nextConfig;
