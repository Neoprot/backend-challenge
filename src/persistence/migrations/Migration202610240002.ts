import { Migration } from '@mikro-orm/migrations';

export class Migration202610240002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create function reject_ledger_mutation() returns trigger language plpgsql as $body$
      begin
        raise exception 'Ledger imutável: alteração ou exclusão proibida' using errcode = '55000';
      end;
      $body$;
      create trigger ledger_no_change before update or delete on wallet_ledger_entry
        for each row execute function reject_ledger_mutation();
      create trigger ledger_no_truncate before truncate on wallet_ledger_entry
        for each statement execute function reject_ledger_mutation();
      revoke update, delete, truncate on wallet_ledger_entry from wager_app;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop trigger ledger_no_truncate on wallet_ledger_entry;
      drop trigger ledger_no_change on wallet_ledger_entry;
      drop function reject_ledger_mutation();
      grant update,delete on wallet_ledger_entry to wager_app;
    `);
  }
}
