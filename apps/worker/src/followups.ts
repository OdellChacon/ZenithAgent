import { outboundIdempotencyKey, windowState, type Channel } from '@zenith/core';
import { withTenant, type Pool, type PoolClient } from '@zenith/db';
import {
  buildSystemPrompt,
  followupNote,
  formatForChannel,
  isRetryableLlmError,
  parseTenantBotSettings,
  renderTemplate,
  templateParam,
  toModelMessages,
  writeFollowup,
  type FollowupSettings,
  type HistoryMessage,
  type LlmClient,
  type TenantBotSettings,
} from '@zenith/brain';

/**
 * Seguimiento a clientes que dejaron de responder, como haría un buen vendedor:
 * - Paso 1: pasado un tiempo sin respuesta, el bot (IA) decide si corresponde escribir y
 *   redacta un mensaje corto que retoma lo que hablaron. Solo dentro de las 24 h.
 * - Paso 2: ya fuera de las 24 h, una plantilla aprobada por Meta (con botones).
 * El bot atiende a toda hora, pero los seguimientos solo salen en el horario del negocio
 * (`sendHours`). Nunca escribe a quien pidió que no le escriban, a conversaciones que atiende
 * un asesor ni dos veces por el mismo silencio.
 */
export interface FollowupDeps {
  pool: Pool;
  llm: LlmClient;
  model: string;
  effort: 'low' | 'medium' | 'high';
  now?: () => Date;
  /** Llamadas a la IA por pasada, para no pasar el límite del proveedor. */
  maxAiCallsPerRun?: number;
  historyLimit?: number;
  /** Solo estos negocios (pruebas). Por defecto, todos los activos. */
  tenantIds?: string[];
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export interface FollowupSent {
  tenantId: string;
  conversationId: string;
  step: 1 | 2;
  outboundMessageId: string;
}

export interface FollowupRun {
  sent: FollowupSent[];
  skipped: number;
  failed: number;
}

const MAX_ATTEMPTS = 3;
/** El paso 1 se manda solo si a la ventana de 24 h le queda al menos esto. */
const WINDOW_MARGIN_MS = 15 * 60_000;
/** Entre el mensaje del paso 1 y la plantilla pasa al menos esto. */
const MIN_GAP_BETWEEN_STEPS_MS = 6 * 60 * 60_000;

const STEP_MS = 5 * 60_000;
/** Si el paso 1 se adelanta, sale en las últimas horas del tramo, lo más cerca posible del momento ideal. */
const PULL_FORWARD_TAIL_MS = 2 * 60 * 60_000;
const DAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const clockFormats = new Map<string, Intl.DateTimeFormat>();

/** Día de la semana (0 = domingo) y minuto del día en la zona horaria del negocio. */
function localClock(at: Date, timezone: string): { day: number; minute: number } {
  let fmt = clockFormats.get(timezone);
  if (!fmt) {
    const opts = { weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' } as const;
    try {
      fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: timezone });
    } catch {
      fmt = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' });
    }
    clockFormats.set(timezone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  return { day: DAYS[parts.weekday!] ?? 0, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** ¿Se pueden enviar seguimientos en este momento? (horario del negocio, en su zona horaria) */
export function inSendHours(at: Date, timezone: string, windows: FollowupSettings['sendHours']): boolean {
  const { day, minute } = localClock(at, timezone);
  return windows.some((w) => w.days.includes(day) && minute >= toMinutes(w.from) && minute < toMinutes(w.to));
}

/**
 * Cuándo toca el paso 1 (mensaje del bot dentro de las 24 h). Lo ideal es `firstAfterMinutes`
 * después de la última respuesta del bot; si ese momento cae fuera de horario o con la ventana ya
 * cerrada (por ejemplo, el cliente escribió de noche), se adelanta al último tramo en horario
 * antes de que cierre, sin bajar de `minFirstAfterMinutes` de silencio. null si no hay momento
 * posible: entonces solo queda la plantilla.
 */
export function firstStepDueAt(p: {
  lastBotAt: Date;
  lastInboundAt: Date;
  timezone: string;
  cfg: Pick<FollowupSettings, 'firstAfterMinutes' | 'minFirstAfterMinutes' | 'sendHours'>;
}): Date | null {
  const lastBot = p.lastBotAt.getTime();
  const preferred = lastBot + p.cfg.firstAfterMinutes * 60_000;
  const earliest = lastBot + Math.min(p.cfg.minFirstAfterMinutes, p.cfg.firstAfterMinutes) * 60_000;
  const deadline = p.lastInboundAt.getTime() + 24 * 60 * 60_000 - WINDOW_MARGIN_MS;
  const open = (t: number) => inSendHours(new Date(t), p.timezone, p.cfg.sendHours);

  // 1. El primer momento en horario desde el ideal, si la ventana sigue abierta.
  for (let t = preferred; t < deadline; t += STEP_MS) if (open(t)) return new Date(t);

  // 2. Si no, el último tramo en horario entre el silencio mínimo y el ideal.
  let end: number | null = null;
  for (let t = Math.min(preferred, deadline) - STEP_MS; t >= earliest; t -= STEP_MS) {
    if (open(t)) {
      end = t;
      break;
    }
  }
  if (end === null) return null;
  let start = end;
  while (start - STEP_MS >= earliest && open(start - STEP_MS)) start -= STEP_MS;
  return new Date(Math.max(start, end - PULL_FORWARD_TAIL_MS + STEP_MS));
}

interface Candidate {
  conversation_id: string;
  channel: Channel;
  last_inbound_at: Date;
  last_bot_at: Date;
  anchor_id: string;
  recipient: string | null;
  contact_name: string | null;
  f1_status: string | null;
  f1_attempts: number | null;
  f1_updated_at: Date | null;
}

export async function runFollowups(deps: FollowupDeps): Promise<FollowupRun> {
  const run: FollowupRun = { sent: [], skipped: 0, failed: 0 };
  const budget = { ai: deps.maxAiCallsPerRun ?? 5 };
  const { rows } = await deps.pool.query<{ id: string }>('SELECT active_tenant_ids() AS id');
  for (const { id } of rows) {
    if (deps.tenantIds && !deps.tenantIds.includes(id)) continue;
    try {
      await runTenant(deps, id, run, budget);
    } catch (err) {
      run.failed++;
      deps.log?.('falló el seguimiento de un negocio', { tenantId: id, err: (err as Error).message });
    }
  }
  return run;
}

async function runTenant(deps: FollowupDeps, tenantId: string, run: FollowupRun, budget: { ai: number }) {
  const now = deps.now?.() ?? new Date();
  const tenant = await withTenant(deps.pool, tenantId, async (c) => {
    const { rows } = await c.query<{ timezone: string; settings: unknown }>('SELECT timezone, settings FROM tenants WHERE id = $1', [tenantId]);
    return rows[0];
  });
  if (!tenant) return;
  let settings: TenantBotSettings;
  try {
    settings = parseTenantBotSettings(tenant.settings);
  } catch {
    return; // sin configuración del bot no hay seguimiento
  }
  const cfg = settings.followups;
  // El bot responde a toda hora; los seguimientos solo salen en horario.
  if (!cfg.enabled || !inSendHours(now, tenant.timezone, cfg.sendHours)) return;

  const candidates = await withTenant(deps.pool, tenantId, async (c) => {
    const { rows } = await c.query<Candidate>(
      `SELECT c.id AS conversation_id, ca.channel, c.last_inbound_at, last_msg.created_at AS last_bot_at,
              last_in.id AS anchor_id, ct.name AS contact_name,
              (SELECT ci.external_user_id FROM contact_identities ci
                WHERE ci.contact_id = c.contact_id AND ci.channel = ca.channel LIMIT 1) AS recipient,
              f1.status AS f1_status, f1.attempts AS f1_attempts, f1.updated_at AS f1_updated_at
         FROM conversations c
         JOIN channel_accounts ca ON ca.id = c.channel_account_id AND ca.status = 'active'
         JOIN contacts ct ON ct.id = c.contact_id AND NOT ct.opt_out_followups
         JOIN LATERAL (SELECT direction, author, created_at FROM messages
                        WHERE conversation_id = c.id ORDER BY seq DESC LIMIT 1) last_msg ON true
         JOIN LATERAL (SELECT id FROM messages
                        WHERE conversation_id = c.id AND direction = 'in' ORDER BY seq DESC LIMIT 1) last_in ON true
         LEFT JOIN followups f1 ON f1.conversation_id = c.id AND f1.anchor_message_id = last_in.id AND f1.step = 1
         LEFT JOIN followups f2 ON f2.conversation_id = c.id AND f2.anchor_message_id = last_in.id AND f2.step = 2
        WHERE c.status <> 'closed' AND c.mode = 'bot'
          -- Lo último lo dijo el bot: el cliente no ha respondido.
          AND last_msg.direction = 'out' AND last_msg.author = 'bot'
          AND c.last_inbound_at > $1::timestamptz - make_interval(days => $2)
          AND (f2.id IS NULL OR (f2.status = 'failed' AND f2.attempts < ${MAX_ATTEMPTS}))
          AND (f1.id IS NULL
               OR (f1.status = 'failed' AND f1.attempts < ${MAX_ATTEMPTS})
               OR ($3 AND (f1.status = 'sent' OR f1.reason = 'ventana')))
        ORDER BY last_msg.created_at
        LIMIT 200`,
      [now, cfg.maxAgeDays, cfg.template !== null],
    );
    return rows;
  });

  for (const cand of candidates) {
    if (!cand.recipient) continue;
    const firstPending = cand.f1_status === null || cand.f1_status === 'failed';
    if (firstPending) {
      const dueAt = firstStepDueAt({
        lastBotAt: new Date(cand.last_bot_at),
        lastInboundAt: new Date(cand.last_inbound_at),
        timezone: tenant.timezone,
        cfg,
      });
      const deadline = new Date(cand.last_inbound_at).getTime() + 24 * 60 * 60_000 - WINDOW_MARGIN_MS;
      if (dueAt === null || now.getTime() >= deadline) {
        // Ya no hay un momento en horario dentro de las 24 h: sin gastar IA, le toca a la plantilla.
        tally(run, await skipFirstStep(deps, tenantId, cand), tenantId, cand.conversation_id, 1);
        continue;
      }
      if (now < dueAt) continue;
      if (budget.ai <= 0) continue;
      const outcome = await firstStep(deps, tenantId, settings, cand, now, budget);
      tally(run, outcome, tenantId, cand.conversation_id, 1);
    } else {
      const template = cfg.template;
      if (!template || cand.channel !== 'whatsapp') continue;
      if (now.getTime() - new Date(cand.last_inbound_at).getTime() < template.afterMinutes * 60_000) continue;
      if (cand.f1_status === 'sent' && cand.f1_updated_at && now.getTime() - new Date(cand.f1_updated_at).getTime() < MIN_GAP_BETWEEN_STEPS_MS) {
        continue;
      }
      const outcome = await templateStep(deps, tenantId, settings, cand);
      tally(run, outcome, tenantId, cand.conversation_id, 2);
    }
  }
}

type StepOutcome = { kind: 'sent'; outboundMessageId: string } | { kind: 'skipped' } | { kind: 'failed' } | { kind: 'busy' };

function tally(run: FollowupRun, outcome: StepOutcome, tenantId: string, conversationId: string, step: 1 | 2) {
  if (outcome.kind === 'sent') run.sent.push({ tenantId, conversationId, step, outboundMessageId: outcome.outboundMessageId });
  else if (outcome.kind === 'skipped') run.skipped++;
  else if (outcome.kind === 'failed') run.failed++;
}

/** Toma el paso para este worker. null si otro ya lo tiene o si todavía no toca reintentar. */
async function claim(deps: FollowupDeps, tenantId: string, cand: Candidate, step: 1 | 2): Promise<string | null> {
  return withTenant(deps.pool, tenantId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO followups (tenant_id, conversation_id, anchor_message_id, step) VALUES ($1, $2, $3, $4)
       ON CONFLICT (conversation_id, anchor_message_id, step) DO UPDATE
         SET status = 'pending', attempts = followups.attempts + 1, reason = NULL, updated_at = now()
         WHERE followups.status = 'failed' AND followups.attempts < ${MAX_ATTEMPTS}
           AND followups.updated_at < now() - interval '10 minutes'
       RETURNING id`,
      [tenantId, cand.conversation_id, cand.anchor_id, step],
    );
    return rows[0]?.id ?? null;
  });
}

async function finishStep(deps: FollowupDeps, tenantId: string, followupId: string, status: 'skipped' | 'failed', reason: string, giveUp = false) {
  await withTenant(deps.pool, tenantId, (c) =>
    c.query(
      `UPDATE followups SET status = $2, reason = $3, updated_at = now(),
              attempts = CASE WHEN $4 THEN ${MAX_ATTEMPTS} ELSE attempts END
        WHERE id = $1`,
      [followupId, status, reason.slice(0, 300), giveUp],
    ),
  );
}

/** Marca el paso 1 como imposible por la ventana de 24 h, para que siga la plantilla. */
async function skipFirstStep(deps: FollowupDeps, tenantId: string, cand: Candidate): Promise<StepOutcome> {
  const followupId = await claim(deps, tenantId, cand, 1);
  if (!followupId) return { kind: 'busy' };
  await finishStep(deps, tenantId, followupId, 'skipped', 'ventana');
  return { kind: 'skipped' };
}

/**
 * Guarda el mensaje y su envío si el cliente sigue sin responder y el bot sigue a cargo.
 * Devuelve el id del envío, o null si la situación cambió mientras se preparaba.
 */
async function saveFollowup(
  deps: FollowupDeps,
  tenantId: string,
  cand: Candidate,
  followupId: string,
  step: 1 | 2,
  message: { type: 'text' | 'template'; body: string; attachments: object[]; payload: object },
): Promise<string | null> {
  return withTenant(deps.pool, tenantId, async (c: PoolClient) => {
    const conv = await c.query<{ mode: string; status: string }>('SELECT mode, status FROM conversations WHERE id = $1 FOR UPDATE', [
      cand.conversation_id,
    ]);
    const last = await c.query<{ id: string; direction: string; author: string }>(
      `SELECT id, direction, author FROM messages WHERE conversation_id = $1 ORDER BY seq DESC LIMIT 1`,
      [cand.conversation_id],
    );
    const lastIn = await c.query<{ id: string }>(
      `SELECT id FROM messages WHERE conversation_id = $1 AND direction = 'in' ORDER BY seq DESC LIMIT 1`,
      [cand.conversation_id],
    );
    const still =
      conv.rows[0]?.mode === 'bot' &&
      conv.rows[0]?.status !== 'closed' &&
      lastIn.rows[0]?.id === cand.anchor_id &&
      last.rows[0]?.direction === 'out' &&
      last.rows[0]?.author === 'bot';
    if (!still) {
      await c.query(`UPDATE followups SET status = 'skipped', reason = 'respondio', updated_at = now() WHERE id = $1`, [followupId]);
      return null;
    }
    const msg = await c.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, author, type, body, attachments)
       VALUES ($1, $2, 'out', 'bot', $3, $4, $5) RETURNING id`,
      [tenantId, cand.conversation_id, message.type, message.body, JSON.stringify(message.attachments)],
    );
    const outbound = await c.query<{ id: string }>(
      `INSERT INTO outbound_messages (tenant_id, conversation_id, message_id, idempotency_key, channel, payload)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        tenantId,
        cand.conversation_id,
        msg.rows[0]!.id,
        outboundIdempotencyKey(cand.conversation_id, cand.anchor_id, `followup:${step}`),
        cand.channel,
        JSON.stringify(message.payload),
      ],
    );
    await c.query(`UPDATE followups SET status = 'sent', reason = NULL, message_id = $2, updated_at = now() WHERE id = $1`, [
      followupId,
      msg.rows[0]!.id,
    ]);
    await c.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [cand.conversation_id]);
    return outbound.rows[0]!.id;
  });
}

async function firstStep(
  deps: FollowupDeps,
  tenantId: string,
  settings: TenantBotSettings,
  cand: Candidate,
  now: Date,
  budget: { ai: number },
): Promise<StepOutcome> {
  const followupId = await claim(deps, tenantId, cand, 1);
  if (!followupId) return { kind: 'busy' };
  budget.ai--;

  const history = await withTenant(deps.pool, tenantId, async (c) => {
    const { rows } = await c.query<HistoryMessage>(
      `SELECT id, direction, author, type, body FROM (
         SELECT id, direction, author, type, body, seq FROM messages
          WHERE conversation_id = $1 ORDER BY seq DESC LIMIT $2) recent
        ORDER BY seq`,
      [cand.conversation_id, deps.historyLimit ?? 30],
    );
    return rows;
  });
  const minutesSilent = (now.getTime() - new Date(cand.last_bot_at).getTime()) / 60_000;

  const started = Date.now();
  let result;
  try {
    result = await writeFollowup({
      llm: deps.llm,
      system: buildSystemPrompt(settings),
      messages: toModelMessages(history, undefined, { trailingNote: followupNote(minutesSilent) }),
      model: deps.model,
      effort: deps.effort,
    });
  } catch (err) {
    // Un error pasajero del proveedor se reintenta en otra pasada; uno permanente, no.
    await finishStep(deps, tenantId, followupId, 'failed', `ia: ${(err as Error).message}`, !isRetryableLlmError(err));
    return { kind: 'failed' };
  }

  const outcome =
    result.draft.decision === 'send' ? 'followup' : result.draft.decision === 'skip' ? 'followup_skip' : 'blocked_by_validator';
  await withTenant(deps.pool, tenantId, (c) =>
    c.query(
      `INSERT INTO ai_runs (tenant_id, conversation_id, trigger_message_id, model, iterations, input_tokens, output_tokens,
                            cache_read_tokens, latency_ms, stop_reason, outcome, error)
       VALUES ($1, $2, $3, $4, 1, $5, $6, $7, $8, NULL, $9, $10)`,
      [
        tenantId,
        cand.conversation_id,
        cand.anchor_id,
        result.model,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.cacheReadTokens,
        Date.now() - started,
        outcome,
        result.draft.decision === 'blocked' ? result.draft.reason : null,
      ],
    ),
  );

  if (result.draft.decision === 'skip') {
    await finishStep(deps, tenantId, followupId, 'skipped', 'no_seguir');
    return { kind: 'skipped' };
  }
  if (result.draft.decision === 'blocked') {
    await finishStep(deps, tenantId, followupId, 'skipped', `bloqueado: ${result.draft.reason}`);
    return { kind: 'skipped' };
  }

  const window = windowState({
    channel: cand.channel,
    lastInboundAt: new Date(cand.last_inbound_at),
    now: deps.now?.() ?? new Date(),
    author: 'bot',
    botSafetyMarginMs: WINDOW_MARGIN_MS,
  });
  if (window !== 'FREE') {
    // Correspondía escribirle, pero ya solo se puede con plantilla: lo hará el paso 2.
    await finishStep(deps, tenantId, followupId, 'skipped', 'ventana');
    return { kind: 'skipped' };
  }

  const text = formatForChannel(result.draft.text, cand.channel);
  const outboundId = await saveFollowup(deps, tenantId, cand, followupId, 1, {
    type: 'text',
    body: text,
    attachments: [{ followup: 1 }],
    payload: { kind: 'text', text, to: cand.recipient, author: 'bot' },
  });
  return outboundId ? { kind: 'sent', outboundMessageId: outboundId } : { kind: 'skipped' };
}

async function templateStep(deps: FollowupDeps, tenantId: string, settings: TenantBotSettings, cand: Candidate): Promise<StepOutcome> {
  const template = settings.followups.template!;
  const followupId = await claim(deps, tenantId, cand, 2);
  if (!followupId) return { kind: 'busy' };

  const bodyParams = template.params.map((p) =>
    templateParam(p, { contactName: cand.contact_name, businessName: settings.business.name, nameFallback: template.nameFallback }),
  );
  const outboundId = await saveFollowup(deps, tenantId, cand, followupId, 2, {
    type: 'template',
    body: renderTemplate(template.preview, bodyParams),
    attachments: [{ followup: 2, template: template.name }],
    payload: { kind: 'template', name: template.name, language: template.language, bodyParams, to: cand.recipient, author: 'bot' },
  });
  return outboundId ? { kind: 'sent', outboundMessageId: outboundId } : { kind: 'skipped' };
}
