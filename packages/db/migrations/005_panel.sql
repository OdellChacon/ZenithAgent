-- 005: usuarios del panel, sesiones y atención por asesores.
--
-- users, memberships y sessions no son de un solo tenant (un usuario puede trabajar para
-- varios negocios), así que no llevan RLS. La API siempre deriva el tenant de la sesión y
-- consulta los datos del negocio con withTenant, donde sí aplica RLS.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_idx ON users (lower(email));

CREATE TABLE memberships (
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tenant_id     uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'agent')),
  notify_email  boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);
CREATE INDEX memberships_tenant_idx ON memberships (tenant_id);

-- Se guarda solo el hash del token de sesión: una copia de la BD no sirve para entrar.
CREATE TABLE sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tenant_id   uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  ip          text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

ALTER TABLE conversations
  ADD CONSTRAINT conversations_assigned_user_fk FOREIGN KEY (assigned_user_id) REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE handoffs
  ADD CONSTRAINT handoffs_taken_by_fk FOREIGN KEY (taken_by) REFERENCES users (id) ON DELETE SET NULL;

-- Quién escribió cada mensaje de asesor.
ALTER TABLE messages ADD COLUMN sent_by_user_id uuid REFERENCES users (id) ON DELETE SET NULL;

GRANT SELECT, INSERT, UPDATE ON users, memberships TO zenith_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO zenith_app;
