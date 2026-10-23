/**
 * Signs (and optionally sends) a sample webhook so the service can be tried locally.
 *
 *   npm run sign -- --source billing --secret "$SECRET"            # print a curl command
 *   npm run sign -- --source billing --secret "$SECRET" --send     # send it with fetch
 */
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  computeSignature,
  formatSignatureHeader,
} from '../src/webhooks/signature.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:3300' },
    source: { type: 'string', default: 'billing' },
    secret: { type: 'string', default: process.env.WEBHOOK_SECRET },
    id: { type: 'string' },
    type: { type: 'string', default: 'invoice.paid' },
    data: { type: 'string', default: '{"invoiceId":"inv_42","amount":1999,"currency":"EUR"}' },
    send: { type: 'boolean', default: false },
  },
});

if (!values.secret) {
  console.error('Missing secret: pass --secret <value> or set WEBHOOK_SECRET.');
  process.exit(1);
}

const id = values.id ?? `evt_${randomUUID()}`;
const timestamp = String(Math.floor(Date.now() / 1000));
const body = JSON.stringify({
  type: values.type,
  occurred_at: new Date().toISOString(),
  data: JSON.parse(values.data) as unknown,
});
const signature = formatSignatureHeader(computeSignature(values.secret, id, timestamp, body));
const endpoint = `${values.url.replace(/\/$/, '')}/webhooks/${values.source}`;
const headers = {
  'content-type': 'application/json',
  [WEBHOOK_ID_HEADER]: id,
  [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
  [WEBHOOK_SIGNATURE_HEADER]: signature,
};

if (values.send) {
  const response = await fetch(endpoint, { method: 'POST', headers, body });
  console.log(`HTTP ${response.status}`);
  console.log(await response.text());
  process.exitCode = response.ok ? 0 : 1;
} else {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const lines = [
    `curl -i -X POST ${quote(endpoint)}`,
    ...Object.entries(headers).map(([name, value]) => `  -H ${quote(`${name}: ${value}`)}`),
    `  --data ${quote(body)}`,
  ];
  console.log(lines.join(' \\\n'));
}
