import { Migration } from '@mikro-orm/migrations';

export class Migration202610240001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallet (
        id uuid primary key,
        player_id uuid not null,
        currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance numeric(30,2) not null check (balance >= 0 and balance <> 'NaN'::numeric),
        version integer not null check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        constraint wallet_player_currency_uq unique (player_id,currency),
        constraint wallet_id_currency_uq unique (id,currency)
      );
      create table wager_transaction (
        id uuid primary key,
        provider_id varchar(120) not null check (length(provider_id) > 0),
        external_transaction_id varchar(200) not null check (length(external_transaction_id) > 0),
        idempotency_key varchar(320) not null check (length(idempotency_key) > 0),
        payload_hash varchar(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        wallet_id uuid not null references wallet(id),
        player_id uuid not null,
        round_id varchar(200) not null,
        game_id varchar(200) not null,
        kind varchar(16) not null check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
        amount numeric(30,2) not null check (amount >= 0 and amount <> 'NaN'::numeric),
        status varchar(24) not null check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        reference_external_transaction_id varchar(200),
        reference_transaction_id uuid references wager_transaction(id),
        failure_code varchar(80),
        created_at timestamptz not null,
        processed_at timestamptz,
        result jsonb,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz,
        reference_deadline timestamptz,
        lease_owner uuid,
        lease_until timestamptz,
        constraint wager_provider_external_uq unique (provider_id,external_transaction_id),
        constraint wager_idempotency_uq unique (idempotency_key),
        constraint wager_id_wallet_currency_uq unique (id,wallet_id,currency),
        check ((kind = 'LOSS' and amount = 0) or (kind <> 'LOSS' and amount > 0)),
        check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        check (reference_external_transaction_id is null or reference_external_transaction_id <> external_transaction_id),
        check (status <> 'PROCESSED' or processed_at is not null),
        check (status <> 'PROCESSED' or not (kind in ('REFUND','ROLLBACK') or (kind = 'WIN' and reference_external_transaction_id is not null)) or reference_transaction_id is not null),
        check (status not in ('REJECTED','FAILED') or failure_code is not null)
      );
      create unique index completed_reversal_reference_uq on wager_transaction(reference_transaction_id)
        where kind in ('REFUND','ROLLBACK') and status = 'PROCESSED';
      create index wager_pending_reference_due_idx on wager_transaction(next_attempt_at,id)
        where status = 'PENDING_REFERENCE';
      create index wager_wallet_idx on wager_transaction(wallet_id,created_at,id);
      create table wallet_ledger_entry (
        id uuid primary key,
        wallet_id uuid not null,
        transaction_id uuid not null,
        direction varchar(6) not null check (direction in ('DEBIT','CREDIT')),
        currency varchar(3) not null,
        amount numeric(30,2) not null check (amount > 0 and amount <> 'NaN'::numeric),
        balance_before numeric(30,2) not null check (balance_before >= 0 and balance_before <> 'NaN'::numeric),
        balance_after numeric(30,2) not null check (balance_after >= 0 and balance_after <> 'NaN'::numeric),
        created_at timestamptz not null,
        constraint ledger_wallet_transaction_uq unique(wallet_id,transaction_id),
        foreign key (wallet_id,currency) references wallet(id,currency),
        foreign key (transaction_id,wallet_id,currency) references wager_transaction(id,wallet_id,currency),
        check ((direction='DEBIT' and balance_before - amount = balance_after)
          or (direction='CREDIT' and balance_before + amount = balance_after))
      );
      create index ledger_wallet_cursor_idx on wallet_ledger_entry(wallet_id,created_at,id);
      create table inbox_message (
        consumer_name varchar(120) not null,
        message_id varchar(200) not null,
        payload_hash varchar(64) not null check (payload_hash ~ '^[0-9a-f]{64}$'),
        received_at timestamptz not null,
        processed_at timestamptz,
        primary key (consumer_name,message_id)
      );
      create table outbox_message (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type varchar(120) not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz,
        published_at timestamptz,
        lease_owner uuid,
        lease_until timestamptz
      );
      create index outbox_pending_due_idx on outbox_message(next_attempt_at,occurred_at,id) where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql('drop table outbox_message; drop table inbox_message; drop table wallet_ledger_entry; drop table wager_transaction; drop table wallet;');
  }
}
