import { SQSClient, CreateQueueCommand, DeleteQueueCommand, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';
import { PostgresUnitOfWork } from '../../src/persistence/unit-of-work';
import { OpenWallet } from '../../src/wallets/application/open-wallet';
import { SubmitWager } from '../../src/wagering/application/submit-wager';
import { UuidIdentifiers } from '../../src/shared/domain/identifiers';
import { Money } from '../../src/shared/domain/money';
import { testEnvironment } from './environment';

export async function inboxFixture(orm: MikroORM) {
  const ids = new UuidIdentifiers(), clock = { now: () => new Date() }, uow = new PostgresUnitOfWork(orm);
  const wallet = await new OpenWallet(uow, clock, ids).execute({ playerId: ids.next(), initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }), correlationId: ids.next() });
  const sqs = new SQSClient({ region: 'us-east-1', endpoint: testEnvironment().sqsEndpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } });
  const queue = await sqs.send(new CreateQueueCommand({ QueueName: `inbox-${ids.next()}.fifo`, Attributes: { FifoQueue: 'true', VisibilityTimeout: '30' } }));
  const queueUrl = queue.QueueUrl!;
  const envelope = { messageId: ids.next(), type: 'WagerTransactionRequested', occurredAt: clock.now().toISOString(), data: {
    providerId: 'aurora', externalTransactionId: ids.next(), idempotencyKey: ids.next(), playerId: wallet.playerId, walletId: wallet.id,
    roundId: 'round', gameId: 'game', kind: 'BET', money: { amount: '25.00', currency: 'BRL' },
  } };
  return { ids, clock, wallet, sqs, queueUrl, envelope, consumerName: `wager-${ids.next()}`, submit: new SubmitWager(uow, clock, ids),
    send: async (body: unknown = envelope) => sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(body), MessageGroupId: wallet.id, MessageDeduplicationId: ids.next() })),
    close: async () => { try { await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })); } finally { sqs.destroy(); } },
  };
}
