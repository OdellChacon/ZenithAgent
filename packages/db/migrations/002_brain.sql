-- 002: pase a asesor y registro de ejecuciones de IA.

CREATE TABLE handoffs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  reason          text NOT NULL CHECK (reason IN (
                    'precio', 'pedido_grande', 'pago', 'queja', 'pide_humano',
                    'fuera_de_alcance', 'seguridad', 'error', 'otro')),
  summary         text,
  requested_at    timestamptz NOT NULL DEFAULT now(),
  taken_by        uuid,
  taken_at        timestamptz,
  returned_at     timestamptz
);
CREATE INDEX handoffs_pending_idx ON handoffs (tenant_id, requested_at) WHERE taken_at IS NULL;

CREATE TABLE ai_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id    uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  trigger_message_id uuid REFERENCES messages (id) ON DELETE SET NULL,
  model              text NOT NULL,
  iterations         integer NOT NULL,
  input_tokens       integer NOT NULL DEFAULT 0,
  output_tokens      integer NOT NULL DEFAULT 0,
  cache_read_tokens  integer NOT NULL DEFAULT 0,
  latency_ms         integer NOT NULL,
  stop_reason        text,
  -- replied | handoff | blocked_by_validator | refusal | error | superseded
  outcome            text NOT NULL,
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_runs_tenant_idx ON ai_runs (tenant_id, created_at DESC);

ALTER TABLE handoffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON handoffs USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE ai_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_runs USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

GRANT SELECT, INSERT, UPDATE ON handoffs TO zenith_app;
GRANT SELECT, INSERT ON ai_runs TO zenith_app;

-- 'sending': un worker tomó el envío. Evita que dos workers manden el mismo mensaje.
ALTER TABLE outbound_messages DROP CONSTRAINT outbound_messages_status_check;
ALTER TABLE outbound_messages ADD CONSTRAINT outbound_messages_status_check
  CHECK (status IN ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'blocked_window'));

-- Búsqueda en el catálogo sin importar tildes ("ceramica" encuentra "Cerámica").
CREATE EXTENSION IF NOT EXISTS unaccent;
