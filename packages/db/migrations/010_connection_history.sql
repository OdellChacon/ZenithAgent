-- 010: estado de la conexión de WhatsApp e historial importado (coexistencia).
--
-- Los avisos de desconexión de Meta (account_update) no traen el phone_number_id, solo la
-- cuenta de WhatsApp Business (WABA). Por eso cada número guarda su waba_id.
-- disconnected_at: Meta desconectó el número de la API (el bot ya no recibe ni envía).
-- disconnect_reason: motivo de Meta (PRIMARY_INACTIVITY, ACCOUNT_OFFBOARDED…).
-- history_status: importing | done | declined (el negocio no compartió su historial).

ALTER TABLE channel_accounts
  ADD COLUMN waba_id           text,
  ADD COLUMN disconnected_at   timestamptz,
  ADD COLUMN disconnect_reason text,
  ADD COLUMN history_status    text CHECK (history_status IN ('importing', 'done', 'declined')),
  ADD COLUMN history_progress  smallint;
CREATE INDEX channel_accounts_waba_idx ON channel_accounts (waba_id) WHERE waba_id IS NOT NULL;

-- El worker solo puede tocar estas columnas, no las credenciales ni el número.
GRANT UPDATE (disconnected_at, disconnect_reason, history_status, history_progress) ON channel_accounts TO zenith_app;

-- Como resolve_channel_account, pero por WABA: puede devolver varios números.
CREATE OR REPLACE FUNCTION resolve_whatsapp_waba(p_waba_id text)
  RETURNS TABLE (channel_account_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT ca.id, ca.tenant_id
    FROM channel_accounts ca
    JOIN tenants t ON t.id = ca.tenant_id
    WHERE ca.channel = 'whatsapp'
      AND ca.waba_id = p_waba_id
      AND ca.status = 'active'
      AND t.status = 'active'
  $$;
REVOKE ALL ON FUNCTION resolve_whatsapp_waba(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_whatsapp_waba(text) TO zenith_app;
