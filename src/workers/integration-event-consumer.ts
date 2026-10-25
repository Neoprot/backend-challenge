import { createHash } from 'node:crypto';
import { ReceiveMessageCommand, DeleteMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { IntegrationEventInbox } from '../messaging/application/integration-event-inbox';
import type { JsonValue } from '../messaging/domain/outbox-message';
function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key]!)]));
  return value;
}
// Demonstra recebimento persistente; sem efeito externo e sem realimentar comandos financeiros.
export class IntegrationEventConsumer {
  constructor(private readonly sqs: Pick<SQSClient, 'send'>, private readonly queueUrl: string, private readonly inbox: IntegrationEventInbox) {}
  async pollOnce(): Promise<number> {
    const result = await this.sqs.send(new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }));
    let received = 0;
    for (const message of result.Messages ?? []) {
      if (!message.Body || !message.ReceiptHandle) throw new Error('Envelope de evento inválido');
      const envelope: unknown = JSON.parse(message.Body);
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('Envelope de evento inválido');
      const event = envelope as Record<string, JsonValue>;
      if (typeof event.eventId !== 'string' || typeof event.aggregateId !== 'string' || typeof event.eventType !== 'string' ||
        typeof event.correlationId !== 'string' || !Number.isInteger(event.version) || typeof event.occurredAt !== 'string' ||
        !Number.isFinite(Date.parse(event.occurredAt)) || !Object.hasOwn(event, 'data')) throw new Error('Envelope de evento inválido');
      const hash = createHash('sha256').update(JSON.stringify(canonical(event))).digest('hex');
      if (await this.inbox.receive(event.eventId, hash)) received++;
      await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
    return received;
  }
}
