-- 011: alta de números desde el panel (Embedded Signup de Meta).
--
-- El dueño o un administrador conecta el número desde el panel: la API (rol de la app, con
-- RLS) crea o actualiza la cuenta del canal de su propio negocio y guarda el token cifrado.
-- on_biz_app: el número sigue en la app WhatsApp Business (coexistencia).

ALTER TABLE channel_accounts ADD COLUMN on_biz_app boolean NOT NULL DEFAULT false;

GRANT INSERT (tenant_id, channel, external_account_id, display_name, waba_id, on_biz_app) ON channel_accounts TO zenith_app;
GRANT UPDATE (display_name, waba_id, on_biz_app, credentials_enc, credentials_key_id, connected_at) ON channel_accounts TO zenith_app;
