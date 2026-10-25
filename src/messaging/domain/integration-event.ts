export interface EventContext {
  eventId: string; correlationId: string; causationId?: string; occurredAt: Date;
}
export interface IntegrationEventProps<T> extends EventContext { aggregateId: string; data: T; }

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) freezeDeep(nested);
    Object.freeze(value);
  }
  return value;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;
  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId: string | undefined;
  readonly #occurredAt: number;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId; this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId; this.causationId = props.causationId;
    this.#occurredAt = props.occurredAt.getTime();
    this.data = freezeDeep(structuredClone(props.data));
  }
  get occurredAt(): Date { return new Date(this.#occurredAt); }
  toJSON(): { eventId: string; eventType: string; aggregateId: string; correlationId: string; causationId?: string; occurredAt: string; version: number; data: T } {
    return { eventId: this.eventId, eventType: this.eventType, aggregateId: this.aggregateId,
      correlationId: this.correlationId, ...(this.causationId === undefined ? {} : { causationId: this.causationId }),
      occurredAt: this.occurredAt.toISOString(), version: this.version, data: structuredClone(this.data) as T };
  }
}
