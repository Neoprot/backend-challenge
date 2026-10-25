# Technical Challenge — Distributed Wagering Processor

# Execução da implementação

A implementação usa Bun 1.3.11, TypeScript estrito, NestJS 12.2.0, MikroORM 7.2.5, PostgreSQL 17.6, SQS no LocalStack 4.11.1 e Keycloak 26.5.2. As decisões e a matriz de testes estão em [ARCHITECTURE.md](ARCHITECTURE.md).

Para revisar a entrega, siga o [passo a passo de execução e testes](docs/TESTING.md), incluindo configuração do `.env`, demonstrações e todas as suítes automatizadas.

## Preparação local

Instale Bun 1.3.11 e Docker com Compose. No Windows, utilize containers Linux no Docker Desktop. Copie `.env.example` para `.env`; o arquivo contém apenas credenciais descartáveis de demonstração e não deve ser reutilizado em produção.

```sh
bun run setup:env
bun install --frozen-lockfile
docker compose up -d --wait
```

Sem profiles, o Compose inicia somente PostgreSQL, LocalStack e Keycloak. Desenvolvimento usa as portas `55432`, `4566` e `8180`; os testes usam outro projeto, outros volumes e as portas `55433`, `4567` e `8181`.

### Aplicação nativa

Com `.env` copiado e a infraestrutura saudável:

```sh
bun run migration:up
bun run start
```

`start` inicia HTTP autenticado, consumidor de comandos SQS, publisher da outbox e worker de referências. A API fica em `http://localhost:3000`. `start:dev` executa esse runtime com watch; `start:workers` é o alias explícito. `start:http` inicia somente HTTP e é útil para testes ou diagnóstico, mas não consome filas nem resolve referências pendentes.

### Três instâncias no Compose

O migrator recebe apenas a credencial de migration. Os containers da API usam `wager_app` e não recebem `MIGRATION_DATABASE_URL`.

```sh
docker compose --profile tools run --rm --build migrator
docker compose --profile app up -d --build --wait --scale api=3
docker compose ps
docker compose port --index 1 api 3000
```

Cada instância recebe uma porta dinâmica, publicada somente em `127.0.0.1`. O último comando informa a porta da primeira instância; repita com `--index 2` ou `3` para as demais. O issuer público continua `http://localhost:8180/realms/wagering`; dentro do container, as chaves JWKS são buscadas em `http://keycloak:8080`, sem alterar a validação do issuer.

Para parar apenas a aplicação:

```sh
docker compose --profile app stop api
```

Não execute migrations reversas em um ambiente com dados que deseje preservar. `migration:down` reverte a última migration; as migrations são versionadas e a reversibilidade é exercitada no banco exclusivo dos testes.

## Seed e demonstração completa

Se estiver usando Compose, ajuste `API_BASE_URL` no `.env` para o endereço informado por `compose port`, por exemplo `http://127.0.0.1:PORTA`. Para a aplicação nativa, o padrão é `http://localhost:3000`.

```sh
bun run seed:local
```

Cada execução cria um novo jogador e uma carteira de `100.00 BRL`, faz uma BET de `25.00` por HTTP, repete exatamente a mesma requisição e envia uma WIN de `10.00` pela SQS. O script aguarda o worker confirmar a WIN e exige reconciliação consistente com três lançamentos e saldo `85.00 BRL`. A saída contém os IDs da carteira e das transações, confirmação do replay e reconciliação. Tokens e client secrets não são impressos. O seed recusa destinos remotos, redirects, URLs com credenciais, query ou fragmento; se os workers não estiverem ativos, ele falha com prazo limitado.

## Tokens e chamadas HTTP

O realm local fornece estes clientes de serviço:

| Cliente              | Secret local            | Papel e escopo                              |
| -------------------- | ----------------------- | ------------------------------------------- |
| `provider-aurora`    | `local-aurora-only`     | `wagering-provider`, `providerId=aurora`    |
| `provider-horizonte` | `local-horizonte-only`  | `wagering-provider`, `providerId=horizonte` |
| `operations-console` | `local-operations-only` | `wagering-admin`, consultas administrativas |

O papel administrativo permite abrir e consultar carteiras, ledger, reconciliação e métricas. O envio de apostas exige o papel de provedor e claim `providerId` correspondente; um token administrativo sozinho não substitui essa identidade. Provedores consultam apenas as próprias transações, inclusive na rota por ID interno.

O exemplo em [scripts/demo-http.ts](scripts/demo-http.ts) roda com Bun em Linux, macOS e Windows. Obtém tokens por `client_credentials`, abre uma carteira, demonstra replay e consulta ledger/reconciliação. Os tokens permanecem no processo. Aceita somente HTTP loopback, com timeout e redirects desativados.

```sh
bun run demo:http
# Para a porta dinâmica do Compose, substitua PORTA pelo valor de compose port:
bun run demo:http http://127.0.0.1:PORTA
```

A primeira aposta retorna `idempotentReplay=false`; a segunda preserva o resultado financeiro original e retorna `true`. Uma consulta por `GET /wagering/transactions/{transactionId}` ou `GET /providers/aurora/wagering/transactions/{externalTransactionId}` usa o token do provedor ou administrativo. `Idempotency-Key` é globalmente única; `externalTransactionId` é único no escopo de `providerId`.

| Resultado                                                               | HTTP  |
| ----------------------------------------------------------------------- | ----- |
| Carteira criada                                                         | `201` |
| Processamento bem-sucedido ou seu replay                                | `200` |
| Referência ainda não disponível                                         | `202` |
| Contrato inválido                                                       | `400` |
| Token ausente ou inválido                                               | `401` |
| Identidade sem acesso ao recurso                                        | `403` |
| Carteira ou transação inexistente                                       | `404` |
| Identidade idempotente com conteúdo divergente ou carteira já existente | `409` |
| Rejeição de negócio persistida ou seu replay                            | `422` |
| Dependência indisponível ou retries transitórios esgotados              | `503` |

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

```sh
docker compose cp seed-message.json localstack:/tmp/wager-seed-message.json
docker compose exec -T localstack awslocal sqs send-message --queue-url http://localhost:4566/queue/us-east-1/000000000000/wager-transactions.fifo --message-body file:///tmp/wager-seed-message.json --message-group-id demo-wallet --message-deduplication-id demo-loss-transport-1
```

Consulte `GET /providers/aurora/wagering/transactions/demo-loss-1`. LOSS confirma a transação e evento, sem alterar saldo, versão da carteira ou ledger. Para forçar uma nova entrega dentro da janela de deduplicação FIFO, altere somente `--message-deduplication-id`; a inbox continuará reconhecendo o `messageId` do envelope. SQS é um canal interno confiável, sem JWT; o contrato e os vínculos de domínio continuam validados. A identidade da inbox é `(consumerName, messageId)` e seu hash inclui o envelope validado completo.

## Saúde, métricas e diagnóstico

`GET /health/live` e `GET /health/ready` são públicos. Liveness independe de PostgreSQL/SQS; readiness verifica os dois com timeout e cancelamento. `GET /metrics` exige administrador e retorna métricas textuais com labels limitadas. Contadores são locais à instância; transições confirmadas e replays têm contagens separadas. O lag da outbox representa a última leitura válida do banco.

Logs da aplicação são JSON e incluem correlação e IDs conhecidos. Tokens, secrets, corpos financeiros completos e mensagens arbitrárias de erro são omitidos. Kysely pode emitir seu próprio diagnóstico de cancelamento SQL; o teste verifica que a consulta cancelada realmente desaparece do servidor.

## Verificação automatizada

O projeto `wagering-test` é exclusivo dos testes e pode sofrer stop/start de seus serviços. Mantenha a aplicação com profile `app` fora desse projeto: o harness cria e encerra seus próprios processos.

```sh
docker compose -f compose.yaml -f compose.test.yaml up -d --wait
bun run typecheck
bun run test:unit
bun run test:it
bun run test:concurrency
```

Os IT usam PostgreSQL, SQS e Keycloak reais. O harness inicia três processos Bun com PIDs, portas e sessões independentes, testa restart e morte em pontos críticos e executa SIGTERM real em Linux. A etapa Linux constrói a imagem e roda depois dos testes nativos para isolar os scans globais dos workers. Não execute as suítes de integração e concorrência em paralelo.

O [checkpoint do plano](docs/superpowers/plans/checkpoint-plan-2026-10-24-wagering.md) registra resultados reais, RED/GREEN, revisões e limitações de sequência TDD. A [matriz de rastreabilidade](ARCHITECTURE.md#rastreabilidade-e-evidências) aponta os testes por requisito. Não foi realizado benchmark de carga.
