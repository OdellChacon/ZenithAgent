-- 016: tipo del último aviso de acceso a Meta.
--
-- credentials_alerted_at limita los correos a uno por día y cuenta. Con el tipo guardado, un
-- aviso de "sin acceso" (invalid) sale aunque ese mismo día ya haya salido uno de "vence
-- pronto" (expiring): el segundo es más grave y no debe esperar al día siguiente.

ALTER TABLE channel_accounts
  ADD COLUMN credentials_alert_state text CHECK (credentials_alert_state IN ('invalid', 'expiring'));

GRANT UPDATE (credentials_alert_state) ON channel_accounts TO zenith_app;
