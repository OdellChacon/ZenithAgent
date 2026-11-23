-- 008: seguimiento automático de clientes que dejaron de responder.
--
-- Cada silencio del cliente se identifica por su último mensaje (anchor_message_id). Por cada
-- silencio hay como máximo un paso 1 (mensaje del bot dentro de las 24 h) y un paso 2
-- (plantilla aprobada por Meta, fuera de las 24 h). Si el cliente vuelve a escribir, su nuevo
-- mensaje abre otro silencio. La restricción UNIQUE evita que dos workers manden el mismo paso.

CREATE TABLE followups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id   uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  anchor_message_id uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  step              smallint NOT NULL CHECK (step IN (1, 2)),
  -- pending: un worker lo está preparando. sent: salió a la cola de envíos.
  -- skipped: no correspondía (ver reason). failed: error; se reintenta hasta 3 veces.
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  -- no_seguir (la IA juzgó que no corresponde) | ventana (correspondía, pero ya no se podía
  -- mandar texto libre) | respondio (el cliente escribió mientras se preparaba) | error…
  reason            text,
  attempts          integer NOT NULL DEFAULT 1,
  message_id        uuid REFERENCES messages (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, anchor_message_id, step)
);
CREATE INDEX followups_tenant_idx ON followups (tenant_id, created_at DESC);

ALTER TABLE followups ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON followups USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE ON followups TO zenith_app;

-- El programador de seguimientos recorre los negocios activos. La app no puede listar
-- tenants (RLS), así que esta función, con permisos del dueño, devuelve solo los ids.
CREATE OR REPLACE FUNCTION active_tenant_ids()
  RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$ SELECT id FROM tenants WHERE status = 'active' $$;
REVOKE ALL ON FUNCTION active_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION active_tenant_ids() TO zenith_app;
