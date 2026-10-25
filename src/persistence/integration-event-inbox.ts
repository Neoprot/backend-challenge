import type { MikroORM } from '@mikro-orm/postgresql';
import type { IntegrationEventInbox } from '../messaging/application/integration-event-inbox';
import { InboxMessage } from '../messaging/domain/inbox-message';
import { InboxRecord } from './records';
export class PostgresIntegrationEventInbox implements IntegrationEventInbox {
  constructor(private readonly orm: MikroORM, private readonly consumerName: string) {}
  async receive(eventId: string, payloadHash: string): Promise<boolean> {
    const received = InboxMessage.receive({ consumerName: this.consumerName, messageId: eventId, payloadHash, receivedAt: new Date() });
    return this.orm.em.fork().transactional(async em => {
      const inserted = await em.execute<{ message_id: string }[]>(`insert into inbox_message
        (consumer_name, message_id, payload_hash, received_at, processed_at) values (?, ?, ?, statement_timestamp(), statement_timestamp())
        on conflict (consumer_name, message_id) do nothing returning message_id`, [received.consumerName, received.messageId, received.payloadHash]);
      if (inserted.length === 1) return true;
      const existing = await em.findOneOrFail(InboxRecord, { consumerName: received.consumerName, messageId: received.messageId });
      InboxMessage.rehydrate(existing).assertSamePayload(received.payloadHash);
      return false;
    });
  }
}
