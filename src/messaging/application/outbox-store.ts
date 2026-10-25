import type { OutboxMessage } from '../domain/outbox-message';
export interface ClaimOptions { limit: number; owner: string; leaseMs: number; now?: Date; ids?: readonly string[]; }
export interface OutboxStore {
  claim(options: ClaimOptions): Promise<OutboxMessage[]>;
  markPublished(id: string, owner: string, now?: Date): Promise<boolean>;
  fail(id: string, owner: string, now?: Date): Promise<boolean>;
}
