-- 001: base multi-tenant de F1 (tenants, canales, eventos de webhook, CRM mínimo, mensajes, catálogo).
--
-- Aislamiento: todas las tablas de negocio llevan tenant_id y RLS. La app se conecta con un
-- rol miembro de zenith_app, que NO es dueño de las tablas, así que las políticas le aplican.
-- El tenant del contexto se fija por transacción con:
--   SELECT set_config('app.tenant_id', '<uuid>', true);
-- Sin tenant fijado, las políticas no devuelven filas.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'zenith_app') THEN
    CREATE ROLE zenith_app NOLOGIN;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION app_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE TYPE channel AS ENUM ('whatsapp', 'instagram', 'messenger', 'tiktok');

-- ---------------------------------------------------------------- tenants y canales

CREATE TABLE tenants (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  slug       text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{2,64}$'),
  status     text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  timezone   text NOT NULL DEFAULT 'UTC',
  currency   char(3) NOT NULL DEFAULT 'USD',
  locale     text NOT NULL DEFAULT 'es',
  settings   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channel_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  channel             channel NOT NULL,
  -- phone_number_id (WhatsApp), page_id (Messenger), ig_user_id (Instagram)…
  external_account_id text NOT NULL,
  display_name        text,
  credentials_enc     bytea,
  credentials_key_id  text,
  status              text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  connected_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel, external_account_id)
);
CREATE INDEX channel_accounts_tenant_idx ON channel_accounts (tenant_id);

-- Resuelve a qué tenant pertenece una cuenta de canal sin dar a la app lectura global de
-- channel_accounts. Corre con los permisos del dueño (no sujeto a RLS) y solo devuelve ids.
CREATE OR REPLACE FUNCTION resolve_channel_account(p_channel channel, p_external_account_id text)
  RETURNS TABLE (channel_account_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT ca.id, ca.tenant_id
    FROM channel_accounts ca
    JOIN tenants t ON t.id = ca.tenant_id
    WHERE ca.channel = p_channel
      AND ca.external_account_id = p_external_account_id
      AND ca.status = 'active'
      AND t.status = 'active'
  $$;
REVOKE ALL ON FUNCTION resolve_channel_account(channel, text) FROM PUBLIC;

-- ---------------------------------------------------------------- eventos de webhook
-- Sin tenant: el gateway los guarda antes de saber a quién pertenecen. No llevan RLS y la
-- app solo puede insertarlos, leerlos y actualizar su estado.

CREATE TABLE webhook_events (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel                     channel NOT NULL,
  external_event_id           text NOT NULL,
  channel_external_account_id text NOT NULL,
  kind                        text NOT NULL,
  normalized                  jsonb NOT NULL,
  payload                     jsonb NOT NULL,
  status                      text NOT NULL DEFAULT 'received'
                                CHECK (status IN ('received', 'processing', 'processed', 'ignored', 'failed')),
  attempts                    integer NOT NULL DEFAULT 0,
  error                       text,
  received_at                 timestamptz NOT NULL DEFAULT now(),
  claimed_at                  timestamptz,
  processed_at                timestamptz,
  UNIQUE (channel, external_event_id)
);
CREATE INDEX webhook_events_pending_idx ON webhook_events (received_at)
  WHERE status IN ('received', 'processing');

-- ---------------------------------------------------------------- CRM y conversaciones

CREATE TABLE contacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name              text,
  phone             text,
  email             text,
  tags              text[] NOT NULL DEFAULT '{}',
  opt_out_followups boolean NOT NULL DEFAULT false,
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_tenant_idx ON contacts (tenant_id);

CREATE TABLE contact_identities (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  channel          channel NOT NULL,
  external_user_id text NOT NULL,
  profile          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel, external_user_id)
);

CREATE TABLE conversations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  contact_id         uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  channel_account_id uuid NOT NULL REFERENCES channel_accounts (id) ON DELETE CASCADE,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'pending', 'closed')),
  mode               text NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot', 'human')),
  assigned_user_id   uuid,
  last_inbound_at    timestamptz,
  last_outbound_at   timestamptz,
  window_expires_at  timestamptz,
  summary            text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- Una sola conversación abierta por contacto y cuenta de canal.
CREATE UNIQUE INDEX conversations_one_open_idx ON conversations (channel_account_id, contact_id)
  WHERE status <> 'closed';
CREATE INDEX conversations_tenant_idx ON conversations (tenant_id, updated_at DESC);

CREATE TABLE messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  direction           text NOT NULL CHECK (direction IN ('in', 'out')),
  author              text NOT NULL CHECK (author IN ('customer', 'bot', 'agent', 'system')),
  type                text NOT NULL,
  body                text,
  attachments         jsonb NOT NULL DEFAULT '[]'::jsonb,
  external_message_id text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);
CREATE UNIQUE INDEX messages_external_idx ON messages (tenant_id, external_message_id)
  WHERE external_message_id IS NOT NULL;

CREATE TABLE outbound_messages (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id     uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  message_id          uuid REFERENCES messages (id) ON DELETE SET NULL,
  idempotency_key     text NOT NULL UNIQUE,
  channel             channel NOT NULL,
  payload             jsonb NOT NULL,
  status              text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'sent', 'delivered', 'read', 'failed', 'blocked_window')),
  attempts            integer NOT NULL DEFAULT 0,
  last_error          text,
  external_message_id text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbound_messages_external_idx ON outbound_messages (tenant_id, external_message_id)
  WHERE external_message_id IS NOT NULL;

-- ---------------------------------------------------------------- catálogo
-- Fuente de verdad de lo que el bot puede ofrecer. price NULL = "el precio lo da un asesor".

CREATE TABLE products (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  source            text NOT NULL,
  external_id       text NOT NULL,
  sku               text,
  name              text NOT NULL,
  category          text,
  category_name     text,
  description       text,
  format            text,
  piece_width_cm    numeric(8, 2),
  piece_length_cm   numeric(8, 2),
  area_per_box_m2   numeric(8, 3),
  pieces_per_box    integer,
  attributes        jsonb NOT NULL DEFAULT '{}'::jsonb,
  price             numeric(12, 2),
  currency          char(3),
  on_offer          boolean NOT NULL DEFAULT false,
  in_visualizer     boolean NOT NULL DEFAULT false,
  active            boolean NOT NULL DEFAULT true,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, external_id)
);
CREATE INDEX products_tenant_category_idx ON products (tenant_id, category) WHERE active;

-- ---------------------------------------------------------------- RLS

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'channel_accounts', 'contacts', 'contact_identities', 'conversations',
    'messages', 'outbound_messages', 'products'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) '
      'WITH CHECK (tenant_id = app_current_tenant())', t);
  END LOOP;
END
$$;

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenants USING (id = app_current_tenant());

-- ---------------------------------------------------------------- permisos de la app

GRANT USAGE ON SCHEMA public TO zenith_app;
GRANT EXECUTE ON FUNCTION app_current_tenant() TO zenith_app;
GRANT EXECUTE ON FUNCTION resolve_channel_account(channel, text) TO zenith_app;

GRANT SELECT ON tenants TO zenith_app;
GRANT SELECT ON channel_accounts TO zenith_app;
GRANT SELECT, INSERT, UPDATE ON webhook_events TO zenith_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON contacts, contact_identities, conversations, messages, outbound_messages
  TO zenith_app;
GRANT SELECT, INSERT, UPDATE ON products TO zenith_app;
