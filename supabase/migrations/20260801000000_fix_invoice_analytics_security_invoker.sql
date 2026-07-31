-- La vue invoice_analytics est créée sans security_invoker : par défaut Postgres/Supabase
-- l'exécute avec les droits du propriétaire (postgres), donc elle contourne la RLS de
-- invoices/sites/communes/contracts pour QUICONQUE la requête via l'API Supabase — fuite
-- cross-org potentielle (alerte "Security Definer View" du linter Supabase).
-- security_invoker = true force la vue à s'exécuter avec les droits de l'appelant, donc la
-- RLS des tables sous-jacentes s'applique normalement.
ALTER VIEW invoice_analytics SET (security_invoker = true);
