/** Payloads con la forma de WhatsApp Cloud API. Datos ficticios. */
export const PHONE_NUMBER_ID = '100000000000001';

export function textWebhook(opts: { id?: string; from?: string; body?: string; timestamp?: string } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '584140000000', phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name: 'Cliente Prueba' }, wa_id: opts.from ?? '584141112233' }],
              messages: [
                {
                  from: opts.from ?? '584141112233',
                  id: opts.id ?? 'wamid.TEXT1',
                  timestamp: opts.timestamp ?? '1763632800',
                  type: 'text',
                  text: { body: opts.body ?? '¿Tienen porcelanato para exterior?' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export const imageWebhook = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_ID',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '584140000000', phone_number_id: PHONE_NUMBER_ID },
            contacts: [{ profile: { name: 'Cliente Prueba' }, wa_id: '584141112233' }],
            messages: [
              {
                from: '584141112233',
                id: 'wamid.IMG1',
                timestamp: '1763632900',
                type: 'image',
                image: { id: 'media-123', mime_type: 'image/jpeg', sha256: 'abc', caption: '¿Tienen esta cerámica?' },
              },
              { from: '584141112233', id: 'wamid.LOC1', timestamp: '1763632901', type: 'location', location: {} },
            ],
          },
        },
      ],
    },
  ],
};

export const statusWebhook = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_ID',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '584140000000', phone_number_id: PHONE_NUMBER_ID },
            statuses: [
              { id: 'wamid.OUT1', status: 'delivered', timestamp: '1763633000', recipient_id: '584141112233' },
              {
                id: 'wamid.OUT2',
                status: 'failed',
                timestamp: '1763633001',
                recipient_id: '584141112233',
                errors: [{ code: 131047, title: 'Re-engagement message' }],
              },
              { id: 'wamid.OUT3', status: 'deleted', timestamp: '1763633002' },
            ],
          },
        },
      ],
    },
  ],
};

/** Copia de mensajes que el negocio mandó desde la app (coexistencia), con la forma de Meta. */
export function echoWebhook(echoes: Record<string, unknown>[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'smb_message_echoes',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '584140000000', phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ wa_id: '584141112233', user_id: 'VE.123' }],
              message_echoes: echoes,
            },
          },
        ],
      },
    ],
  };
}

/** Historial que Meta manda al conectar un número que ya usaba la app (coexistencia). */
export function historyWebhook(history: Record<string, unknown>[]) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'history',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '584140000000', phone_number_id: PHONE_NUMBER_ID },
              history,
            },
          },
        ],
      },
    ],
  };
}

export function accountUpdateWebhook(value: Record<string, unknown>, entryId = 'WABA_ID', time = 1763632800) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: entryId, time, changes: [{ field: 'account_update', value }] }],
  };
}
