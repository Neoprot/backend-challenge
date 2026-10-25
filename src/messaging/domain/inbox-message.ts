import { DomainError } from '../../shared/domain/domain-error';
export interface InboxContext {
  readonly consumerName: string;
  readonly messageId: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}
export class InboxMessage {
  private constructor(readonly consumerName: string, readonly messageId: string, readonly payloadHash: string,
    private readonly received: number, private readonly processed: number | null) { Object.freeze(this); }
  static receive(context: InboxContext): InboxMessage { return this.rehydrate({ ...context, processedAt: null }); }
  static rehydrate(context: InboxContext & { processedAt: Date | null }): InboxMessage {
    if (!context.consumerName.trim() || context.consumerName.length > 120 || !context.messageId.trim() || context.messageId.length > 200
      || !/^[a-f0-9]{64}$/u.test(context.payloadHash) || !Number.isFinite(context.receivedAt.getTime())
      || (context.processedAt !== null && (!Number.isFinite(context.processedAt.getTime()) || context.processedAt < context.receivedAt))) {
      throw new DomainError('INVALID_INBOX', 'Mensagem de inbox inválida.');
    }
    return new InboxMessage(context.consumerName, context.messageId, context.payloadHash, context.receivedAt.getTime(), context.processedAt?.getTime() ?? null);
  }
  get receivedAt(): Date { return new Date(this.received); }
  get processedAt(): Date | null { return this.processed === null ? null : new Date(this.processed); }
  complete(at: Date): InboxMessage {
    return this.processed === null ? InboxMessage.rehydrate({ ...this, receivedAt: this.receivedAt, processedAt: at }) : this;
  }
  assertSamePayload(hash: string): void {
    if (hash !== this.payloadHash) throw new InboxConflict();
  }
}
export class InboxConflict extends DomainError {
  readonly httpStatus = 409;
  constructor() { super('INBOX_PAYLOAD_CONFLICT', 'Conteúdo diverge da mensagem já recebida pelo consumidor.'); }
}
