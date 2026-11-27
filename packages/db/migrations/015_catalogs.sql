-- 015: catálogos de productos que los asesores comparten con los clientes.
--
-- El dueño o un administrador sube los catálogos (PDF, fotos u otros documentos) desde el panel;
-- los asesores los ven y los mandan a un chat arrastrándolos. Un catálogo "eliminado" se
-- archiva (archived_at) para que los mensajes donde ya se mandó lo sigan mostrando.

CREATE TABLE catalogs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  description text CHECK (char_length(description) <= 300),
  media_type  text NOT NULL CHECK (media_type IN ('image', 'video', 'document')),
  mime_type   text NOT NULL,
  filename    text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 240),
  bytes       integer NOT NULL CHECK (bytes > 0),
  sha256      text NOT NULL,
  data        bytea NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE INDEX catalogs_tenant_idx ON catalogs (tenant_id, created_at DESC) WHERE archived_at IS NULL;

-- Como channel_media con las fotos del catálogo: el id que devuelve cada canal al subir el
-- archivo se reutiliza (WhatsApp lo guarda 30 días) para no subir el mismo PDF en cada envío.
CREATE TABLE catalog_media (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts (id) ON DELETE CASCADE,
  catalog_id         uuid NOT NULL REFERENCES catalogs (id) ON DELETE CASCADE,
  sha256             text NOT NULL,
  external_media_id  text NOT NULL,
  uploaded_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_account_id, catalog_id)
);

ALTER TABLE catalogs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON catalogs USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE catalog_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON catalog_media USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON catalogs TO zenith_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON catalog_media TO zenith_app;
