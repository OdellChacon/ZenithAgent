-- 018: categorías, mensaje predeterminado, uso y envío por el bot de los catálogos.
--
-- - category: para filtrar y buscar cuando hay muchos catálogos (texto libre, ej. "Grifería").
-- - default_message: texto que se propone al mandar el catálogo a un chat.
-- - bot_enabled: si el bot puede mandar este catálogo (cuando el negocio lo permite en general).
-- - catalog_settings: si el bot puede mandar catálogos. Va en su propia tabla para no darle al
--   rol de la app permiso de escritura sobre tenants.settings.
-- - Índices para detectar un archivo repetido al subirlo y para contar cuántas veces se mandó
--   cada catálogo (sale de outbound_messages, donde ya queda cada envío).

ALTER TABLE catalogs
  ADD COLUMN category text CHECK (char_length(category) BETWEEN 1 AND 40),
  ADD COLUMN default_message text CHECK (char_length(default_message) BETWEEN 1 AND 1000),
  ADD COLUMN bot_enabled boolean NOT NULL DEFAULT true;

CREATE INDEX catalogs_sha_idx ON catalogs (tenant_id, sha256) WHERE archived_at IS NULL;

CREATE INDEX outbound_messages_catalog_idx ON outbound_messages (tenant_id, (payload->>'catalogId'))
  WHERE payload->>'kind' = 'catalog';

CREATE TABLE catalog_settings (
  tenant_id    uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  bot_can_send boolean NOT NULL DEFAULT false,
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE catalog_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON catalog_settings USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON catalog_settings TO zenith_app;
