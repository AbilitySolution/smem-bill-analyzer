-- C-1: Scope storage uploads to owner's folder (previously any authenticated user could upload to any folder)
DROP POLICY IF EXISTS "authenticated_upload_invoice_files" ON storage.objects;
CREATE POLICY "owner_upload_invoice_files" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'invoice-files'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- C-2: pending_uploads table and pending-uploads bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'pending-uploads',
  'pending-uploads',
  false,
  20971520, -- 20 MB
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/tiff']
)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS pending_uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  commune_id uuid REFERENCES communes(id) ON DELETE CASCADE,
  file_request_link_id uuid REFERENCES file_request_links(id) ON DELETE SET NULL,
  file_path text NOT NULL,
  original_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'error')),
  processed_invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pending_uploads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin_all_pending_uploads" ON pending_uploads
  FOR ALL USING (is_admin_smem());

-- Storage policies for pending-uploads bucket (admin write, no public read)
CREATE POLICY "admin_upload_pending_files" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'pending-uploads' AND is_admin_smem());

CREATE POLICY "admin_read_pending_files" ON storage.objects
  FOR SELECT USING (bucket_id = 'pending-uploads' AND is_admin_smem());

CREATE POLICY "admin_delete_pending_files" ON storage.objects
  FOR DELETE USING (bucket_id = 'pending-uploads' AND is_admin_smem());
