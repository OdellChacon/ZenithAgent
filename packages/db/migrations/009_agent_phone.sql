-- 009: asesores que responden desde la app de WhatsApp Business (coexistencia).
--
-- Cuando llega la copia de un mensaje que alguien del negocio mandó desde la app, el bot se
-- calla en esa conversación (mode = 'human') y se guarda cuándo fue. Si el asesor no vuelve a
-- escribir en un tiempo (settings.takeover.resumeBotAfterMinutes), el bot retoma al siguiente
-- mensaje del cliente. NULL = el asesor no ha escrito desde la app en este tramo.

ALTER TABLE conversations ADD COLUMN agent_active_at timestamptz;
