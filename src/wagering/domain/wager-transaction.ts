import { DomainError } from '../../shared/domain/domain-error';
import { Money } from '../../shared/domain/money';
import type { LedgerDirection } from '../../wallets/domain/ledger-entry';
import type { FailureCode } from './failure-code';

export type WagerTransactionKind = 'OPENING' | 'BET' | 'WIN' | 'LOSS' | 'REFUND' | 'ROLLBACK';
export type WagerTransactionStatus = 'PENDING' | 'PENDING_REFERENCE' | 'PROCESSED' | 'REJECTED' | 'FAILED';
export interface CreateWagerTransactionProps {
  id: string; providerId: string; externalTransactionId: string; idempotencyKey: string;
  payloadHash: string; walletId: string; playerId: string; roundId: string; gameId: string;
  kind: WagerTransactionKind; money: Money; referenceExternalTransactionId?: string; createdAt: Date;
}
export interface WagerTransactionState extends CreateWagerTransactionProps {
  status: WagerTransactionStatus; referenceTransactionId?: string; failureCode?: FailureCode; processedAt?: Date;
}

export class WagerTransaction {
  readonly #props: Readonly<Omit<CreateWagerTransactionProps, 'createdAt'>>;
  readonly #createdAt: number;
  #status: WagerTransactionStatus;
  #referenceTransactionId: string | undefined;
  #failureCode: FailureCode | undefined;
  #processedAt: number | undefined;

  private constructor(state: WagerTransactionState) {
    const { createdAt, status, referenceTransactionId, failureCode, processedAt, ...props } = state;
    this.#props = Object.freeze(props);
    this.#createdAt = createdAt.getTime();
    this.#status = status;
    this.#referenceTransactionId = referenceTransactionId;
    this.#failureCode = failureCode;
    this.#processedAt = processedAt?.getTime();
  }

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!['OPENING','BET','WIN','LOSS','REFUND','ROLLBACK'].includes(props.kind)) throw new DomainError('INVALID_KIND', 'Tipo de transação inválido.');
    if ((props.kind === 'LOSS' && !props.money.isZero()) || (props.kind !== 'LOSS' && !props.money.isPositive())) {
      throw new DomainError('INVALID_AMOUNT', 'LOSS exige zero; movimentações exigem valor positivo.');
    }
    if ((props.kind === 'REFUND' || props.kind === 'ROLLBACK') && !props.referenceExternalTransactionId?.trim()) {
      throw new DomainError('REFERENCE_REQUIRED', 'Reversão exige referência.');
    }
    if (props.referenceExternalTransactionId === props.externalTransactionId) throw new DomainError('SELF_REFERENCE', 'Transação não pode referenciar a si mesma.');
    return new WagerTransaction({ ...props, status: 'PENDING' });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction { return new WagerTransaction(state); }
  get id() { return this.#props.id; }
  get providerId() { return this.#props.providerId; }
  get externalTransactionId() { return this.#props.externalTransactionId; }
  get idempotencyKey() { return this.#props.idempotencyKey; }
  get payloadHash() { return this.#props.payloadHash; }
  get walletId() { return this.#props.walletId; }
  get playerId() { return this.#props.playerId; }
  get roundId() { return this.#props.roundId; }
  get gameId() { return this.#props.gameId; }
  get kind() { return this.#props.kind; }
  get money() { return this.#props.money; }
  get referenceExternalTransactionId() { return this.#props.referenceExternalTransactionId; }
  get createdAt() { return new Date(this.#createdAt); }
  get status() { return this.#status; }
  get referenceTransactionId() { return this.#referenceTransactionId; }
  get failureCode() { return this.#failureCode; }
  get processedAt() { return this.#processedAt === undefined ? undefined : new Date(this.#processedAt); }

  markProcessed(referenceTransactionId: string | undefined, at: Date): void {
    this.assertNotTerminal();
    if ((this.requiresReference() || (this.kind === 'WIN' && this.referenceExternalTransactionId !== undefined)) && !referenceTransactionId?.trim()) {
      throw new DomainError('REFERENCE_REQUIRED', 'Processamento exige referência interna resolvida.');
    }
    this.#status = 'PROCESSED'; this.#referenceTransactionId = referenceTransactionId; this.#processedAt = at.getTime();
  }
  markPendingReference(): void { this.assertNotTerminal(); this.#status = 'PENDING_REFERENCE'; }
  reject(code: FailureCode): void { this.assertNotTerminal(); this.#status = 'REJECTED'; this.#failureCode = code; }
  fail(code: FailureCode): void { this.assertNotTerminal(); this.#status = 'FAILED'; this.#failureCode = code; }
  isTerminal(): boolean { return ['PROCESSED', 'REJECTED', 'FAILED'].includes(this.status); }
  affectsBalance(): boolean { return this.kind !== 'LOSS'; }
  requiresReference(): boolean { return this.kind === 'REFUND' || this.kind === 'ROLLBACK'; }
  matchesPayload(hash: string): boolean { return this.payloadHash === hash; }
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | null {
    switch (this.kind) {
      case 'LOSS': return null;
      case 'BET': return 'DEBIT';
      case 'OPENING': case 'WIN': case 'REFUND': return 'CREDIT';
      case 'ROLLBACK':
        if (!reference || !['BET', 'WIN', 'REFUND'].includes(reference.kind)) throw new DomainError('INVALID_REFERENCE_KIND', 'Referência inválida para ROLLBACK.');
        return reference.kind === 'BET' ? 'CREDIT' : 'DEBIT';
    }
  }
  private assertNotTerminal(): void {
    if (this.isTerminal()) throw new DomainError('INVALID_TRANSACTION_STATE', 'Transação terminal não pode mudar de estado.');
  }
}
