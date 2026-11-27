-- 014: salud del token de cada canal, archivos que mandan los asesores y ediciones/borrados.
--
-- Token (channel_accounts):
--   token_expires_at: cuándo vence el token, si Meta lo dijo (por defecto el token de
--     integración de negocio no vence; vence a los 60 días si así se configuró el registro).
--   credentials_invalid_at / credentials_error: Meta rechazó el token (vencido o revocado).
--     Mientras siga así el bot no puede enviar en esa cuenta: hay que volver a conectarla.
--   credentials_checked_at: última revisión diaria del token.
--   credentials_alerted_at: último correo de aviso (para no mandar uno por cada mensaje).

ALTER TABLE channel_accounts
  ADD COLUMN token_expires_at       timestamptz,
  ADD COLUMN credentials_invalid_at timestamptz,
  ADD COLUMN credentials_error      text,
  ADD COLUMN credentials_checked_at timestamptz,
  ADD COLUMN credentials_alerted_at timestamptz;

GRANT UPDATE (token_expires_at, credentials_invalid_at, credentials_error, credentials_checked_at, credentials_alerted_at)
  ON channel_accounts TO zenith_app;

-- Mensajes editados o borrados (por el cliente o por el negocio desde la app).
ALTER TABLE messages
  ADD COLUMN edited_at  timestamptz,
  ADD COLUMN deleted_at timestamptz;

-- Archivos que un asesor manda desde el panel (foto, video o documento). Se guardan para
-- poder reintentar el envío y para que el panel los muestre después.
CREATE TABLE message_files (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  uploaded_by     uuid,
  media_type      text NOT NULL CHECK (media_type IN ('image', 'video', 'document')),
  mime_type       text NOT NULL,
  filename        text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 240),
  bytes           integer NOT NULL CHECK (bytes > 0),
  sha256          text NOT NULL,
  data            bytea NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX message_files_conversation_idx ON message_files (conversation_id);

ALTER TABLE message_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_files USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, DELETE ON message_files TO zenith_app;
