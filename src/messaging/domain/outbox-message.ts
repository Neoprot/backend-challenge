export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface OutboxState {
  id: string; aggregateId: string; eventType: string; payload: JsonValue; occurredAt: Date;
  attempts: number; nextAttemptAt: Date | null; publishedAt: Date | null;
  leaseOwner: string | null; leaseUntil: Date | null;
}
export class OutboxMessage {
  readonly #state: OutboxState;
  private constructor(state: OutboxState) { this.#state = structuredClone(state); Object.freeze(this); }
  static create(input: Pick<OutboxState, 'id' | 'aggregateId' | 'eventType' | 'payload' | 'occurredAt'>): OutboxMessage {
    return this.rehydrate({ ...input, attempts: 0, nextAttemptAt: null, publishedAt: null, leaseOwner: null, leaseUntil: null });
  }
  static rehydrate(state: OutboxState): OutboxMessage {
    if (!state.id || !state.aggregateId || !state.eventType || !Number.isSafeInteger(state.attempts) || state.attempts < 0) throw new Error('Evento de outbox inválido');
    for (const date of [state.occurredAt, state.nextAttemptAt, state.publishedAt, state.leaseUntil]) {
      if (date !== null && (!(date instanceof Date) || !Number.isFinite(date.getTime()))) throw new Error('Data de outbox inválida');
    }
    if ((state.leaseOwner === null) !== (state.leaseUntil === null) ||
      (state.publishedAt !== null && (state.leaseOwner !== null || state.nextAttemptAt !== null))) throw new Error('Estado de outbox incoerente');
    return new OutboxMessage(state);
  }
  snapshot(): OutboxState { return structuredClone(this.#state); }
  isDue(now: Date): boolean {
    return this.#state.publishedAt === null && (this.#state.nextAttemptAt === null || this.#state.nextAttemptAt <= now) &&
      (this.#state.leaseUntil === null || this.#state.leaseUntil <= now);
  }
  retry(now: Date): OutboxMessage {
    if (this.#state.publishedAt !== null) throw new Error('Evento já publicado');
    return OutboxMessage.rehydrate({ ...this.#state, attempts: this.#state.attempts + 1,
      nextAttemptAt: new Date(now.getTime() + Math.min(300000, 1000 * 2 ** Math.min(this.#state.attempts, 9))), leaseOwner: null, leaseUntil: null });
  }
  published(now: Date): OutboxMessage {
    if (this.#state.publishedAt !== null) throw new Error('Evento já publicado');
    return OutboxMessage.rehydrate({ ...this.#state, publishedAt: now, nextAttemptAt: null, leaseOwner: null, leaseUntil: null });
  }
}
