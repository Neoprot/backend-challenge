# Technical Challenge — Distributed Wagering Processor

## Bem-vindo à Jungle Gaming 🦧

A **Jungle Gaming** é uma software house especializada em iGaming — desenvolvemos plataformas de cassino online com tecnologia de ponta: NestJS, Bun, TanStack, DDD e arquitetura orientada a eventos. Somos apaixonados por engenharia de software e acreditamos que grandes produtos nascem de grandes times.

Este desafio é a porta de entrada para fazer parte desse time. Ele foi desenhado para refletir problemas reais do nosso dia a dia: sistemas distribuídos, tempo real, precisão monetária, experiência de usuário e arquitetura bem pensada.

Não esperamos perfeição — esperamos raciocínio claro, código limpo e decisões justificadas. Mostre como você pensa e como você constrói.

---

## 1. Visão geral

Construa um serviço financeiro distribuído que processe transações de apostas recebidas de múltiplos provedores de jogos.

Este desafio **não** avalia CRUD nem familiaridade superficial com NestJS. A avaliação é centrada em:

- correção financeira;
- concorrência entre múltiplas instâncias;
- idempotência persistente;
- consistência entre saldo materializado e ledger;
- processamento assíncrono e recuperação após falhas;
- clareza das decisões técnicas.

O sistema deve permanecer correto quando mensagens forem **duplicadas**, entregues **fora de ordem** ou processadas **simultaneamente**.

---

## 2. Autenticação — a cargo do candidato

Esta seção vem antes do resto justamente para você dimensionar o timebox: **autenticação não vale pontos** na tabela de avaliação (seção 14) e não deve competir com correção financeira, concorrência e idempotência. O desafio **não prescreve** um mecanismo — a escolha, o desenho e a implementação são de sua responsabilidade, e serão discutidos na apresentação.

Se você implementar, a expectativa é **integrar um Identity Provider externo**, não escrever autenticação artesanal. Nada de tabela própria de usuários com hash de senha. Sugestões que sobem bem em Docker Compose:

**Keycloak** (mais comum no mercado, OIDC completo) e **Zitadel** (mais leve, API-first) são pontos de partida razoáveis; qualquer IdP equivalente serve.

Se você optar por **não** implementar, isso é aceito: documente a decisão no `ARCHITECTURE.md`, descreva o desenho que adotaria e deixe o ponto de extensão explícito no código (por exemplo um `AuthGuard` no-op ou um `ProviderIdentityPort`).

Escopo do que a autenticação **não** cobre neste desafio: os endpoints de health ficam abertos, e mensagens vindas da fila são tratadas como canal interno confiável — mas a identidade do provedor contida na mensagem continua sujeita às mesmas validações de domínio.

---

## 3. Contexto do domínio

Provedores enviam operações associadas a uma rodada:

```
BET → WIN | LOSS | REFUND | ROLLBACK
```

A entrega é **at-least-once**. Portanto assuma que:

- a mesma operação pode chegar várias vezes;
- uma operação dependente pode chegar antes da operação referenciada;
- várias instâncias podem tocar a mesma wallet ao mesmo tempo;
- o processo pode morrer antes ou depois do commit;
- eventos podem ser publicados mais de uma vez;
- PostgreSQL e SQS podem ficar temporariamente indisponíveis.

**Invariantes globais:** o sistema não pode duplicar créditos, duplicar débitos, perder eventos confirmados ou permitir saldo negativo.

---

## 4. Stack

### Obrigatória

| Item | Escolha |
|---|---|
| Runtime / package manager / test runner | **Bun 1.x** |
| Linguagem | **TypeScript** em modo estrito |
| Framework | **NestJS** |
| Banco | **PostgreSQL** |
| Mensageria | **AWS SQS** via **LocalStack** ou **MiniStack** |
| Orquestração local | **Docker Compose** |
| Migrations | versionadas e reversíveis |

### ORM

Use **uma** das opções:

- **MikroORM — preferencial** (Unit of Work e Identity Map explícitos, `EntityManager.transactional()`, `LockMode`);
- **TypeORM** — aceito.

**Prisma e outros ORMs estão fora do escopo.** A escolha, o mapeamento do `Money` e a estratégia transacional adotada devem ser justificados em `ARCHITECTURE.md`.

## 5. Restrições invioláveis

1. Não usar `number`, `float` ou `double` para dinheiro.
2. Não usar cache em memória como garantia de idempotência.
3. Não confiar apenas em SQS FIFO para garantir consistência.
4. Não publicar eventos antes do commit da transação financeira.
5. Não sobrescrever nem excluir lançamentos do ledger.
6. Não usar lock global compartilhado por todas as wallets.
7. Não implementar saldo como `read → calculate → update` sem controle de concorrência.
8. A solução deve estar correta com **múltiplas instâncias** da aplicação.
9. As garantias de unicidade, imutabilidade e não-negatividade descritas na seção 6 devem ser aplicadas **no schema do banco**, não apenas em código de aplicação. O desenho do schema, das constraints e dos índices é parte do que está sendo avaliado.

---

## 6. Modelo de domínio

Nomes e assinaturas podem ser adaptados, desde que as garantias sejam preservadas.

### 6.0 Regra de modelagem

- Construtor `private` ou `protected` + **factories estáticas** (`create`, `from`, `rehydrate`);
- a reidratação a partir do banco usa a factory `rehydrate`, que **não** revalida regras de transição — apenas reconstrói estado já persistido.

Os blocos abaixo são **esqueletos de referência**: o que importa é que o estado seja encapsulado e as transições sejam explícitas.

### 6.1 Money

```ts
// DTO — interface é adequada aqui
interface MoneyProps {
  amount: string;   // decimal string, ex.: "25.00"
  currency: string; // ISO-4217
}

class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money;
  static zero(currency: string): Money;

  add(other: Money): Money;
  subtract(other: Money): Money;
  negate(): Money;

  isZero(): boolean;
  isPositive(): boolean;
  isNegative(): boolean;
  isLessThan(other: Money): boolean;
  equals(other: Money): boolean;

  toJSON(): MoneyProps;
  toString(): string;

  private assertSameCurrency(other: Money): void;
}
```

`Money` é **imutável**: toda operação retorna uma nova instância.

Regras:

- `amount` é **recebido e serializado como string decimal**, sempre com escala fixa de **2** casas;
- operações entre moedas diferentes lançam erro de domínio;
- entradas inválidas são rejeitadas: `NaN`, `Infinity`, notação científica, string vazia, mais de 2 casas decimais, valores negativos em contratos de entrada;
- o domínio **não** depende de tipos monetários do ORM nem de decorators do NestJS;
- na persistência, valor e moeda podem ocupar colunas separadas, desde que a representação seja exata e reidratada como `Money`.

Para reduzir escopo, **todo o desafio pode assumir uma única moeda (`BRL`)**, desde que o modelo continue multi-moeda e os conflitos de moeda sejam testados.

Formato nos contratos:

```json
{ "amount": "25.00", "currency": "BRL" }
```

### 6.2 Wallet (Aggregate Root)

```ts
class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet;

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet;

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  // Aplicam a movimentação mantendo saldo e ledger consistentes entre si.
  // Assinatura e retorno são decisão sua.
  debit(/* ... */): /* ... */;
  credit(/* ... */): /* ... */;

  private assertSameCurrency(money: Money): void;
}
```

Invariantes:

- no máximo **uma wallet por `playerId` + `currency`**;
- saldo nunca negativo;
- **toda alteração de saldo tem um lançamento correspondente no ledger** (e vice-versa);
- operações concorrentes não podem causar lost update;
- a moeda da operação deve ser igual à moeda da wallet;
- `version` inicia em `1` após a criação e **incrementa somente quando o saldo muda**.

`version` é sugerido para optimistic locking, mas outra estratégia é aceita se justificada.

### 6.3 WagerTransaction

```ts
enum WagerTransactionKind {
  Opening  = "OPENING",   // interno: crédito de abertura da wallet
  Bet      = "BET",
  Win      = "WIN",
  Loss     = "LOSS",
  Refund   = "REFUND",
  Rollback = "ROLLBACK",
}

enum WagerTransactionStatus {
  Pending          = "PENDING",            // aceita, ainda não aplicada
  PendingReference = "PENDING_REFERENCE",  // aguardando a transação referenciada
  Processed        = "PROCESSED",          // aplicada (terminal)
  Rejected         = "REJECTED",           // violação de regra de negócio (terminal)
  Failed           = "FAILED",             // erro permanente de infraestrutura (terminal, auditável)
}

class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction;
  static rehydrate(state: WagerTransactionState): WagerTransaction;

  get status(): WagerTransactionStatus { return this._status; }
  get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
  get failureCode(): FailureCode | undefined { return this._failureCode; }
  get processedAt(): Date | undefined { return this._processedAt; }

  // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal)
  markProcessed(referenceTransactionId: string | undefined, at: Date): void;
  markPendingReference(): void;
  reject(code: FailureCode): void;
  fail(code: FailureCode): void;

  // ---- consultas de domínio
  isTerminal(): boolean;
  affectsBalance(): boolean;      // false para LOSS
  requiresReference(): boolean;   // true para REFUND e ROLLBACK
  matchesPayload(payloadHash: string): boolean;
  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection;
}
```

`PROCESSED`, `REJECTED` e `FAILED` são **terminais**: uma transação que chegou a um deles não muda mais de estado, e tentar transicioná-la é erro de programação, não caminho de negócio. Defina e documente as transições válidas.

- `OPENING` é **interno**: não pode ser submetido pela API nem pela fila.
- A mesma idempotency key com payload diferente é **conflito**, não replay.

### 6.4 WalletLedgerEntry (imutável)

```ts
enum LedgerDirection { Debit = "DEBIT", Credit = "CREDIT" }

class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry;
  static rehydrate(state: LedgerEntryState): WalletLedgerEntry;

  /** balanceBefore ± money === balanceAfter. Verificada na factory. */
  isBalanced(): boolean;
}
```

**Sem campos mutáveis e sem métodos de transição** — a imutabilidade é estrutural, não uma convenção. `create` valida a aritmética do lançamento.

- Uma transação financeira produz **no máximo um lançamento por wallet**.
- Operações sem efeito no saldo (`LOSS`, e qualquer transação `REJECTED`) **não geram lançamento**.
- Ledger de **partidas dobradas** (*double-entry bookkeeping*) é diferencial opcional, não requisito.

### 6.5 Inbox e Outbox

```ts
class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage;
  static rehydrate(state: InboxMessageState): InboxMessage;

  get processedAt(): Date | undefined { return this._processedAt; }

  isProcessed(): boolean;
  markProcessed(at: Date): void;
}

class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage;
  static rehydrate(state: OutboxMessageState): OutboxMessage;

  get attempts(): number { return this._attempts; }
  get nextAttemptAt(): Date | undefined { return this._nextAttemptAt; }
  get publishedAt(): Date | undefined { return this._publishedAt; }

  isPending(): boolean;
  isDue(now: Date): boolean;
  markPublished(at: Date): void;
  /** incrementa attempts e calcula o próximo nextAttemptAt (backoff) */
  scheduleRetry(now: Date): void;
}
```

Inbox, alteração financeira, ledger e outbox participam da **mesma transação SQL**.

---

## 7. Regras de negócio

| Operação | Efeito no saldo | Ledger | Regra principal |
|---|---|---|---|
| `BET` | débito | 1 entrada `DEBIT` | rejeitar se saldo insuficiente |
| `WIN` | crédito | 1 entrada `CREDIT` | pode referenciar a `BET` da mesma rodada |
| `LOSS` | nenhum | nenhuma | registra o resultado sem mover saldo |
| `REFUND` | crédito | 1 entrada `CREDIT` | reverte uma `BET` `PROCESSED`, uma única vez |
| `ROLLBACK` | inverso da referência | 1 entrada invertida | reverte uma transação `PROCESSED`, uma única vez |

Regras adicionais:

1. `REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId`.
2. A referência é resolvida por `(providerId, referenceExternalTransactionId)` e deve pertencer ao **mesmo provider, player, wallet, moeda e rodada**.
3. `REFUND` só referencia `BET`. `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`.
4. Uma referência não pode ser revertida duas vezes pelo mesmo tipo de operação.
5. O valor de `REFUND`/`ROLLBACK` deve ser **igual** ao valor da referência (reversão parcial está fora de escopo).
6. Transação `REJECTED` não altera saldo nem gera ledger.
7. Repetir uma operação já processada retorna **o resultado original**, incluindo o saldo observado naquele momento.
8. Referência ausente → persistir como `PENDING_REFERENCE` e reprocessar depois (ver 7.1).
9. Reversão que produziria saldo negativo é **rejeitada explicitamente**, com um `failureCode` distinto do de uma aposta sem saldo — são situações operacionalmente diferentes — e permanece auditável.

Qualquer interpretação adicional adotada deve ser documentada.

### 7.1 Referências fora de ordem

- Transações `PENDING_REFERENCE` são reprocessadas por um **worker agendado** com backoff exponencial.
- Limite de tentativas ou TTL definido e justificado por você.
- Esgotado o limite: `REJECTED` com um `failureCode` que identifique a referência inexistente, e evento correspondente publicado.

### 7.2 Códigos de falha

Toda rejeição precisa carregar um `failureCode` estável e legível por máquina, suficiente para o provedor decidir se reenvia, corrige o payload ou desiste. A taxonomia é sua — defina-a e documente-a.

---

## 8. Concorrência e ordenação

A **unidade de concorrência é a `walletId`**.

A solução deve manter a correção quando:

- duas apostas disputam o mesmo saldo;
- múltiplos workers recebem operações da mesma wallet;
- wallets diferentes são processadas em paralelo;
- **três ou mais instâncias** rodam simultaneamente.

A estratégia é sua escolha — pessimistic locking, optimistic locking com retry limitado, update atômico condicionado ou uma combinação — e deve ser justificada em `ARCHITECTURE.md`.

Recursos de ordenação e deduplicação do broker são **otimização**, não a garantia final: o banco continua responsável pelas invariantes.

### Cenário obrigatório

Saldo inicial `100.00 BRL`. Duas apostas de `80.00 BRL` processadas simultaneamente.

Resultado esperado:

- exatamente uma aposta `PROCESSED`;
- a outra `REJECTED` por saldo insuficiente;
- saldo final `20.00 BRL`;
- exatamente **um** lançamento de débito no ledger;
- nenhum retry duplica o débito.

---

## 9. API HTTP

Autenticação dos endpoints abaixo: ver **seção 2**.

### Criar wallet

```http
POST /wallets
```

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "1000.00", "currency": "BRL" }
}
```

O saldo inicial, quando maior que zero, gera uma transação interna `OPENING` **na mesma transação SQL**, com lançamento `CREDIT` correspondente no ledger.

```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "1000.00", "currency": "BRL" },
  "version": 1
}
```

Criar wallet duplicada para o mesmo `playerId` + `currency` deve falhar como conflito.

### Consultas

```http
GET /wallets/:walletId
GET /wallets/:walletId/ledger?cursor=...&limit=50   # cursor estável e opaco
GET /wagering/transactions/:transactionId
GET /providers/:providerId/wagering/transactions/:externalTransactionId
```

### Submeter transação

```http
POST /wagering/transactions
Idempotency-Key: provider-a:transaction-123
```

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "transaction-123",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "roundId": "round-987",
  "gameId": "fortune-chimp",
  "kind": "BET",
  "money": { "amount": "25.00", "currency": "BRL" }
}
```

```json
{
  "transactionId": "0192f298-345e-7e38-af88-e43f851a819d",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

**Idempotência:**

- o header `Idempotency-Key` é obrigatório e é a fonte da verdade;
- default recomendado: `"{providerId}:{externalTransactionId}"`;
- `payloadHash` = hash de um **JSON canônico** (chaves ordenadas) do subconjunto de campos de negócio — o header e metadados de transporte não entram no hash. O algoritmo deve estar documentado;
- requisição idêntica → mesma resposta, `idempotentReplay: true`;
- mesma key com payload diferente → conflito, e **não** replay.

**Status HTTP:** o mapeamento é decisão sua, mas a API precisa distinguir com clareza — e de forma consistente entre todos os endpoints — payload inválido, conflito de idempotência, rejeição por regra de negócio, aceite com processamento pendente e falha transitória de infraestrutura. Colapsar essas situações em um mesmo código obriga o provedor a interpretar mensagem de erro para decidir se pode reenviar.

### Reconciliação

```http
POST /wallets/:walletId/reconciliation
```

```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance":     { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference":        { "amount": "0.00",   "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 42
}
```

Divergências **não** são corrigidas silenciosamente: devem ser logadas, contabilizadas em métrica e sinalizadas na resposta.

### Health checks

```http
GET /health/live     # processo vivo
GET /health/ready    # PostgreSQL e SQS alcançáveis
```

Os endpoints de health **não** devem exigir autenticação.

---

## 10. Processamento por SQS

Filas:

```
wager-transactions.fifo
wager-transactions-dlq.fifo
```

Mensagem:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

O consumidor deve:

- reutilizar **o mesmo use case** da entrada HTTP;
- deduplicar via **inbox persistente** por `(consumerName, messageId)`;
- fazer `ack` **somente após o commit**;
- distinguir erros de **negócio** (terminal, ack), **transitórios** (retry com backoff) e **permanentes** (DLQ);
- respeitar um limite de tentativas antes da DLQ;
- em `SIGTERM`, concluir mensagens em andamento ou devolver a visibilidade;
- suportar redelivery sem duplicar efeitos.

---

## 11. Transactional Outbox

A persistência da transação, a alteração de saldo, o lançamento no ledger, o registro de inbox (quando a entrada for SQS) e o evento de integração precisam ser **atômicos**: ou tudo é confirmado junto, ou nada é.

Um **worker** publica os eventos pendentes e precisa funcionar com múltiplos publishers concorrentes, sem perder nem duplicar indefinidamente.

Cenário que precisa funcionar:

1. o PostgreSQL confirma o commit;
2. o processo morre antes de publicar;
3. outra instância assume o trabalho;
4. o evento é publicado;
5. uma publicação duplicada continua segura para o consumidor.

### Eventos mínimos

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | qualquer transação aplicada, inclusive `LOSS` |
| `WagerTransactionRejected` | transação rejeitada por regra de negócio |
| `WalletBalanceChanged` | **somente** quando o saldo muda |
| `WagerTransactionPendingReference` | referência ausente |

Envelope — **classe abstrata**, com uma subclasse concreta por evento:

```ts
interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) { /* ... */ }

  /** Envelope serializado gravado no payload da outbox. */
  toJSON(): {
    eventId: string;
    eventType: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: string;   // ISO-8601
    version: number;
    data: T;
  };
}
```

Exemplo de subclasse — o `eventType` e a `version` ficam **no tipo**, não em uma string solta no call site:

```ts
interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged;
}
```

`data` carrega `MoneyProps` (string decimal), nunca a instância de `Money` — o payload precisa ser JSON estável e versionável.

---

## 12. Observabilidade

Obrigatório:

- **logs estruturados** (JSON) com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`;
- **sem** dados sensíveis ou payloads financeiros completos nos logs;
- **métricas** cobrindo, no mínimo: transações por status, duplicatas detectadas, retries, mensagens em DLQ, conflitos de lock, outbox lag e latência de processamento;
- **health checks** separados para liveness e readiness.

OpenTelemetry e dashboard são opcionais.

---

## 13. Testes obrigatórios

### Unidade

- operações e validações de `Money` (escala, arredondamento, entradas inválidas);
- invariantes da `Wallet`;
- regras de `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`;
- conflito de moeda;
- idempotency key com payload divergente.

### Integração (PostgreSQL e LocalStack/MiniStack reais em containers)

- migrations e constraints;
- atomicidade entre wallet, ledger, inbox e outbox;
- inbox e redelivery;
- publishers concorrentes sobre a mesma outbox;
- retry e DLQ;
- recuperação após reinicialização.

### Concorrência (paralelismo real, não mocks sequenciais)

1. a mesma aposta enviada **50 vezes em paralelo** → um único débito;
2. operações concorrentes disputando o saldo da mesma wallet (cenário da seção 8);
3. wallets distintas processadas em paralelo;
4. **≥ 3 processos/instâncias** simultâneos;
5. worker morto **depois do commit e antes do ack**;
6. dois publishers sobre a mesma outbox;
7. `ROLLBACK` ou `REFUND` entregue antes da referência;
8. reinício do serviço com comprovação da consistência final.

**Invariante final de todos os testes:**

```
wallet.balance == saldo reconstruído pelo ledger
```

---

## 14. Avaliação — 100 pontos

| Área | Pontos | O que será observado |
|---|---|---|
| Correção financeira | 20 | `Money`, saldo, ledger, reversões, reconciliação |
| Concorrência | 20 | lost updates, hot wallet, múltiplas instâncias, locks |
| Idempotência | 15 | dedup persistente, replay, payload conflitante |
| Mensageria e falhas | 15 | inbox, outbox, retry, DLQ, crash recovery, shutdown |
| Modelagem e arquitetura | 10 | invariantes encapsuladas em classes, boundaries, portas, simplicidade |
| Testes | 10 | integração real, races, determinismo, cobertura de falhas |
| Observabilidade | 5 | logs, métricas, health checks, diagnóstico |
| Documentação | 5 | `README.md` com setup e comandos, `ARCHITECTURE.md` com decisões, trade-offs e limitações |

### Falhas eliminatórias

- `number` para dinheiro;
- saldo negativo causado por race;
- débito ou crédito duplicado;
- idempotência apenas em memória;
- solução correta somente com uma instância;
- publicação de evento antes do commit;
- ausência de ledger auditável;
- testes que substituem completamente PostgreSQL e SQS por mocks.

### Diferenciais opcionais

Teste de carga também conta como diferencial. Se fizer, exponha como `bun run test:load` e registre ambiente, metodologia, throughput, p50/p95/p99, taxa de erro, conflitos de concorrência e outbox lag. Não há meta de RPS — a qualidade do experimento e a honestidade da análise pesam mais que o número bruto.

---

# Execução da implementação

O enunciado acima foi preservado. A implementação usa Bun 1.3.11, TypeScript estrito, NestJS 12.2.0, MikroORM 7.2.5, PostgreSQL 17.6, SQS no LocalStack 4.11.1 e Keycloak 26.5.2. As decisões e a matriz de testes estão em [ARCHITECTURE.md](ARCHITECTURE.md).

Para revisar a entrega, siga o [passo a passo de execução e testes](docs/TESTING.md), incluindo configuração do `.env`, demonstrações e todas as suítes automatizadas.

## Preparação local

Instale Bun 1.3.11 e Docker com Compose. No Windows, utilize containers Linux no Docker Desktop. Copie `.env.example` para `.env`; o arquivo contém apenas credenciais descartáveis de demonstração e não deve ser reutilizado em produção.

```powershell
bun install --frozen-lockfile
docker compose up -d --wait
```

Sem profiles, o Compose inicia somente PostgreSQL, LocalStack e Keycloak. Desenvolvimento usa as portas `55432`, `4566` e `8180`; os testes usam outro projeto, outros volumes e as portas `55433`, `4567` e `8181`.

### Aplicação nativa

Com `.env` copiado e a infraestrutura saudável:

```powershell
bun run migration:up
bun run start
```

`start` inicia HTTP autenticado, consumidor de comandos SQS, publisher da outbox e worker de referências. A API fica em `http://localhost:3000`. `start:dev` executa esse runtime com watch; `start:workers` é o alias explícito. `start:http` inicia somente HTTP e é útil para testes ou diagnóstico, mas não consome filas nem resolve referências pendentes.

### Três instâncias no Compose

O migrator recebe apenas a credencial de migration. Os containers da API usam `wager_app` e não recebem `MIGRATION_DATABASE_URL`.

```powershell
docker compose --profile tools run --rm --build migrator
docker compose --profile app up -d --build --wait --scale api=3
docker compose ps
docker compose port --index 1 api 3000
```

Cada instância recebe uma porta dinâmica, publicada somente em `127.0.0.1`. O último comando informa a porta da primeira instância; repita com `--index 2` ou `3` para as demais. O issuer público continua `http://localhost:8180/realms/wagering`; dentro do container, as chaves JWKS são buscadas em `http://keycloak:8080`, sem alterar a validação do issuer.

Para parar apenas a aplicação:

```powershell
docker compose --profile app stop api
```

Não execute migrations reversas em um ambiente com dados que deseje preservar. `migration:down` reverte a última migration; as migrations são versionadas e a reversibilidade é exercitada no banco exclusivo dos testes.

## Seed e demonstração completa

Se estiver usando Compose, ajuste `API_BASE_URL` no `.env` para o endereço informado por `compose port`, por exemplo `http://127.0.0.1:PORTA`. Para a aplicação nativa, o padrão é `http://localhost:3000`.

```powershell
bun run seed:local
```

Cada execução cria um novo jogador e uma carteira de `100.00 BRL`, faz uma BET de `25.00` por HTTP, repete exatamente a mesma requisição e envia uma WIN de `10.00` pela SQS. O script aguarda o worker confirmar a WIN e exige reconciliação consistente com três lançamentos e saldo `85.00 BRL`. A saída contém os IDs da carteira e das transações, confirmação do replay e reconciliação. Tokens e client secrets não são impressos. O seed recusa destinos remotos, redirects, URLs com credenciais, query ou fragmento; se os workers não estiverem ativos, ele falha com prazo limitado.

## Tokens e chamadas HTTP

O realm local fornece estes clientes de serviço:

| Cliente | Secret local | Papel e escopo |
| --- | --- | --- |
| `provider-aurora` | `local-aurora-only` | `wagering-provider`, `providerId=aurora` |
| `provider-horizonte` | `local-horizonte-only` | `wagering-provider`, `providerId=horizonte` |
| `operations-console` | `local-operations-only` | `wagering-admin`, consultas administrativas |

O papel administrativo permite abrir e consultar carteiras, ledger, reconciliação e métricas. O envio de apostas exige o papel de provedor e claim `providerId` correspondente; um token administrativo sozinho não substitui essa identidade. Provedores consultam apenas as próprias transações, inclusive na rota por ID interno.

O exemplo versionado em [scripts/demo-http.ps1](scripts/demo-http.ps1) obtém tokens por `client_credentials`, abre uma carteira, demonstra replay e consulta ledger/reconciliação. Os tokens permanecem em variáveis do processo. Executar o arquivo evita que outra camada de CLI remova as aspas do script no Windows. O parâmetro aceita somente HTTP loopback, e as chamadas têm timeout e redirects desativados.

```powershell
powershell -NoProfile -File scripts/demo-http.ps1
# Para a porta dinâmica do Compose, substitua PORTA pelo valor de compose port:
powershell -NoProfile -File scripts/demo-http.ps1 -ApiBaseUrl http://127.0.0.1:PORTA
```

A primeira aposta retorna `idempotentReplay=false`; a segunda preserva o resultado financeiro original e retorna `true`. Uma consulta por `GET /wagering/transactions/{transactionId}` ou `GET /providers/aurora/wagering/transactions/{externalTransactionId}` usa o token do provedor ou administrativo. `Idempotency-Key` é globalmente única; `externalTransactionId` é único no escopo de `providerId`.

| Resultado | HTTP |
| --- | --- |
| Carteira criada | `201` |
| Processamento bem-sucedido ou seu replay | `200` |
| Referência ainda não disponível | `202` |
| Contrato inválido | `400` |
| Token ausente ou inválido | `401` |
| Identidade sem acesso ao recurso | `403` |
| Carteira ou transação inexistente | `404` |
| Identidade idempotente com conteúdo divergente ou carteira já existente | `409` |
| Rejeição de negócio persistida ou seu replay | `422` |
| Dependência indisponível ou retries transitórios esgotados | `503` |

`FAILED` representa falha técnica permanente atribuível a uma operação válida, com resultado técnico `500`. Não é usado para indisponibilidade temporária nem para rejeição de negócio. Toda resposta de erro inclui `correlationId`; a aplicação não devolve stack, SQL ou credenciais.

## Integração com AWS SQS

A integração utiliza o SDK oficial `@aws-sdk/client-sqs` e executa contra o LocalStack, conforme a stack exigida pelo desafio. Não é necessário criar uma conta AWS para executar ou testar o projeto.

- `wager-transactions.fifo`: recebe comandos processados pelo [SqsConsumer](src/workers/sqs-consumer.ts), com inbox persistente, ACK após commit e renovação de visibilidade.
- `wager-transactions-dlq.fifo`: recebe mensagens inválidas/falhas permanentes e o redrive após cinco recebimentos.
- `wager-events.fifo`: recebe eventos confirmados da outbox, publicados pelo [OutboxPublisher](src/workers/outbox-publisher.ts), com leases e recuperação após falhas.

As filas e a política de redrive são criadas por [infra/localstack/init.sh](infra/localstack/init.sh). O `.env.example` fornece endpoint, região, credenciais fictícias locais e URLs das filas. O seed demonstra uma WIN enviada por SQS e aguarda o processamento antes de reconciliar o saldo. Os testes de integração e concorrência verificam duplicatas, DLQ, indisponibilidade e morte do processo nos pontos críticos.

## Mensagens SQS reproduzíveis

O seed já demonstra o envio real. Para um envio manual, crie `seed-message.json` em UTF-8, substituindo `PLAYER_UUID` e `WALLET_UUID` pelos IDs retornados pelo seed. Use IDs novos para uma nova operação; para testar redelivery, preserve o envelope completo.

```json
{
  "messageId": "demo-loss-1",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-10-25T00:00:00.000Z",
  "data": {
    "providerId": "aurora",
    "externalTransactionId": "demo-loss-1",
    "idempotencyKey": "demo-loss-key-1",
    "playerId": "PLAYER_UUID",
    "walletId": "WALLET_UUID",
    "roundId": "round-demo",
    "gameId": "game-demo",
    "kind": "LOSS",
    "money": { "amount": "0.00", "currency": "BRL" }
  }
}
```

```powershell
docker compose cp seed-message.json localstack:/tmp/wager-seed-message.json
docker compose exec -T localstack awslocal sqs send-message --queue-url http://localhost:4566/queue/us-east-1/000000000000/wager-transactions.fifo --message-body file:///tmp/wager-seed-message.json --message-group-id demo-wallet --message-deduplication-id demo-loss-transport-1
```

Consulte `GET /providers/aurora/wagering/transactions/demo-loss-1`. LOSS confirma a transação e evento, sem alterar saldo, versão da carteira ou ledger. Para forçar uma nova entrega dentro da janela de deduplicação FIFO, altere somente `--message-deduplication-id`; a inbox continuará reconhecendo o `messageId` do envelope. SQS é um canal interno confiável, sem JWT; o contrato e os vínculos de domínio continuam validados. A identidade da inbox é `(consumerName, messageId)` e seu hash inclui o envelope validado completo.

## Saúde, métricas e diagnóstico

`GET /health/live` e `GET /health/ready` são públicos. Liveness independe de PostgreSQL/SQS; readiness verifica os dois com timeout e cancelamento. `GET /metrics` exige administrador e retorna métricas textuais com labels limitadas. Contadores são locais à instância; transições confirmadas e replays têm contagens separadas. O lag da outbox representa a última leitura válida do banco.

Logs da aplicação são JSON e incluem correlação e IDs conhecidos. Tokens, secrets, corpos financeiros completos e mensagens arbitrárias de erro são omitidos. Kysely pode emitir seu próprio diagnóstico de cancelamento SQL; o teste verifica que a consulta cancelada realmente desaparece do servidor.

## Verificação automatizada

O projeto `wagering-test` é exclusivo dos testes e pode sofrer stop/start de seus serviços. Mantenha a aplicação com profile `app` fora desse projeto: o harness cria e encerra seus próprios processos.

```powershell
docker compose -f compose.yaml -f compose.test.yaml up -d --wait
bun run typecheck
bun run test:unit
bun run test:it
bun run test:concurrency
```

Os IT usam PostgreSQL, SQS e Keycloak reais. O harness inicia três processos Bun com PIDs, portas e sessões independentes, testa restart e morte em pontos críticos e executa SIGTERM real em Linux. A etapa Linux constrói a imagem e roda depois dos testes nativos para isolar os scans globais dos workers. Não execute as suítes de integração e concorrência em paralelo.

O [checkpoint do plano](docs/superpowers/plans/checkpoint-plan-2026-10-24-wagering.md) registra resultados reais, RED/GREEN, revisões e limitações de sequência TDD. A [matriz de rastreabilidade](ARCHITECTURE.md#rastreabilidade-e-evidências) aponta os testes por requisito. Não foi realizado benchmark de carga.
