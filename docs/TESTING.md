# Guia de execução e testes

Abra um terminal na pasta do repositório, na branch `codex/feat-distributed-wagering`. São necessários Bun 1.3.11 e Docker com Compose; no Windows, utilize containers Linux no Docker Desktop.

## 1. Preparar o ambiente

Na primeira execução, copie o exemplo. `-NoClobber` preserva um `.env` que já exista.

```powershell
powershell -NoProfile -Command "Copy-Item -LiteralPath .env.example -Destination .env -NoClobber"
bun install --frozen-lockfile
```

O `.env.example` contém banco da aplicação, credencial separada de migrations, Keycloak, filas e configurações exclusivas de testes. Os valores são fixtures locais. O `.env` está no `.gitignore`; somente o exemplo deve ser versionado.

## 2. Iniciar PostgreSQL, SQS e Keycloak

```powershell
docker compose up -d --wait postgres localstack keycloak
```

Espere o comando terminar com sucesso. As portas de desenvolvimento são PostgreSQL `55432`, LocalStack `4566` e Keycloak `8180`.

## 3. Escolher como executar a aplicação

Use uma das alternativas abaixo. Ambas iniciam HTTP, consumidor SQS, publisher da outbox e worker de referências.

### Alternativa A: Bun local

```powershell
bun run migration:up
bun run start
```

Mantenha esse terminal aberto. A API fica em `http://localhost:3000`. Use outro terminal na mesma pasta para os próximos passos; o `API_BASE_URL` padrão do `.env.example` já corresponde a esse endereço.

### Alternativa B: três instâncias no Docker

```powershell
docker compose --profile tools run --rm --build migrator
docker compose --profile app up -d --build --wait --scale api=3
docker compose --profile app ps
docker compose port --index 1 api 3000
```

O último comando retorna um endereço como `127.0.0.1:53470`. Atualize `API_BASE_URL` no seu `.env` para esse endereço, com `http://` na frente. A porta é dinâmica: confira novamente após recriar containers. Os índices `2` e `3` mostram as demais instâncias.

O Compose configura os endereços internos dos serviços. Não substitua os endereços locais do `.env` pelos nomes `postgres`, `localstack` ou `keycloak` ao executar comandos Bun no host. A API usa `wager_app`; somente o migrator recebe a credencial de migrations.

## 4. Executar a demonstração completa

```powershell
bun run seed:local
```

O script obtém tokens reais no Keycloak e executa:

1. Abertura de carteira com `100.00 BRL`.
2. BET de `25.00` por HTTP.
3. Replay da mesma BET, sem novo débito.
4. WIN de `10.00` pela SQS, aguardando o processamento real.
5. Reconciliação do saldo e ledger.

Confira a saída: `replayConfirmed: true`, saldo `85.00 BRL`, `consistent: true` e `checkedEntries: 3`. Cada execução cria novos dados de demonstração. Os tokens não são impressos.

Para testar também o exemplo HTTP em PowerShell:

```powershell
powershell -NoProfile -File scripts/demo-http.ps1 -ApiBaseUrl http://localhost:3000
```

No Docker, substitua a URL pela porta descoberta no passo 3. Esse exemplo cria outra carteira, faz BET e replay e consulta ledger/reconciliação. O resultado esperado é saldo `75.00 BRL`, mesma transação no replay e dois lançamentos.

## 5. Conferir saúde e autenticação

Abra `/health/live` e `/health/ready` na URL da API. Devem responder `200`, com `alive` e `ready`, respectivamente. São endpoints públicos.

Uma chamada sem token a `/wallets/ID`, `/wagering/transactions/ID` ou `/metrics` deve ser recusada com `401`. O exemplo PowerShell e o seed já demonstram chamadas autenticadas. Os testes de identidade verificam também `403` por provedor/papel incorreto, assinatura, expiração, issuer, audience e rotação real de chaves.

## 6. Executar toda a verificação automatizada

Os testes utilizam o projeto separado `wagering-test`, banco/volume próprios e portas `55433`, `4567` e `8181`. A suíte reinicia serviços e verifica migrations reversíveis nesse ambiente. Preserve os destinos `TEST_*` do exemplo e não inicie o profile `app` nesse projeto: o harness inicia seus próprios processos.

Execute os comandos nesta ordem, sem rodar integração e concorrência em paralelo:

```powershell
docker compose -f compose.yaml -f compose.test.yaml up -d --wait postgres localstack keycloak
bun run typecheck
bun run test:unit
bun run test:it
bun run test:concurrency
```

| Comando | O que verifica |
| --- | --- |
| `typecheck` | TypeScript estrito e compatibilidade dos tipos |
| `test:unit` | Money, regras financeiras, estados, idempotência, políticas, retry, logs e guardas do seed/harness |
| `test:it` | PostgreSQL/SQS/Keycloak reais, atomicidade, constraints, ledger imutável, precisão, HTTP, autenticação, referências, inbox/outbox, DLQ e quedas reais das dependências |
| `test:concurrency` | Três processos independentes, 50 BET duplicadas, disputa de saldo, independência entre carteiras, reversão única, publishers concorrentes, reinício, morte após commit/envio e SIGTERM real em Linux |

Todos os comandos devem terminar com código zero. A última validação da implementação registrou **259 unitários, 132 IT e 16 testes de concorrência/recuperação**, todos aprovados, além de typecheck e demonstrações reais. O preflight de três testes é repetido dentro dos IT e não está somado novamente.

A matriz detalhada está em [ARCHITECTURE.md](../ARCHITECTURE.md#rastreabilidade-e-evidências). O [checkpoint](superpowers/plans/checkpoint-plan-2026-10-24-wagering.md) registra as evidências e revisões.

## 7. Diagnosticar e encerrar

Para conferir containers e logs do runtime Docker:

```powershell
docker compose --profile app ps
docker compose --profile app logs --tail 100 api
```

Se o seed não encontrar a API, confira `API_BASE_URL` e a porta atual. Se a WIN não concluir, confira se usou `start` ou o profile `app`: `start:http` inicia somente HTTP. Se uma porta de infraestrutura estiver ocupada, confira os processos/containers que a utilizam antes de iniciar outra instalação.

Para parar as instâncias Docker e a infraestrutura, preservando os volumes:

```powershell
docker compose --profile app stop api
docker compose stop postgres localstack keycloak
docker compose -f compose.yaml -f compose.test.yaml stop postgres localstack keycloak
```

Na execução nativa, encerre `bun run start` com Ctrl+C. O encerramento coordenado é exercitado pela suíte; os testes não exigem matar manualmente processos ou corromper dados.

LocalStack está sem persistência interna do broker: após reiniciar, suas filas são recriadas. A outbox permanece no PostgreSQL; a limitação e as garantias de entrega at-least-once estão detalhadas na arquitetura.
