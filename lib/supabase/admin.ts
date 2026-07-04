import { createClient } from "@supabase/supabase-js";

// Service-role client — server-only, bypasses RLS. Used for OCR ingestion
// and demo data seeding where the writing identity is the server, not an end user.
export function createAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}
