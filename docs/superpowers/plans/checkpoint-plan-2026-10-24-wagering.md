# Checkpoint — execução do plano 2026-10-24-wagering

Plano aprovado pelo usuário. Execução na branch codex/wagering-processor, em worktree isolado a partir de 411c1bc.

## Controle de tarefas

| Tarefa | Estado |
| --- | --- |
| 1 — Bootstrap e ambiente real | COMPLETE |
| 2 — Money | COMPLETE |
| 3 — Wallet e ledger | COMPLETE |
| 4 — Transações e eventos | COMPLETE |
| 5 — Schema e migrations | COMPLETE |
| 6 — Unidade de trabalho e abertura | COMPLETE |
| 7 — Canonicalização e idempotência | IN_PROGRESS |
| 8–19 | PENDING |

## Tarefa 1 — bootstrap e ambiente real

**Execution Mode:** Inline.

**Intenção:** preparar Bun/TypeScript/NestJS/MikroORM e serviços reais isolados de PostgreSQL, SQS/LocalStack e Keycloak; verificar conexão antes de implementar finanças.

**Plano revisado:** implementação financeira permanece nas tarefas posteriores; TDD exige RED observável antes de GREEN. Configuração inicial é exceção mecânica aprovada. Revisões ocorrerão na ordem conformidade, depois qualidade.

**Ambiente:** Bun 1.3.11; Docker CLI 29.3.0. Docker Desktop iniciado, aguardando disponibilidade do daemon Linux. Sem testes preexistentes no repositório.

**Arquivos alterados:** package.json/bun.lock/tsconfig.json, Compose/Dockerfile e ignores, configuração de ambiente, inicializadores PostgreSQL/LocalStack/Keycloak, runner IT e testes unitários/de integração.

**Evidências TDD:** configuração: três falhas comportamentais com scaffold; após implementação, três passam. Proteção do harness: duas falhas (aceitava destino indevido e não fornecia padrões); após implementação, duas passam. A primeira execução de integração encontrou ECONNREFUSED porque os serviços ainda não existiam; isso é baseline de infraestrutura, não RED de negócio. Depois do startup, o teste apontou QueueDoesNotExist; PostgreSQL e Keycloak já passavam. Correções comprovadas nos logs: endpoint explícito no CLI AWS e preservação de escapes no JSON da DLQ.

**Validação final:** `bun run typecheck` passa; `bun run test:unit` tem 5 pass/0 fail; `bun run test:it` tem 4 pass/0 fail, mais preflight de 3 testes. Compose up --wait termina com exit 0. Runtime Bun 1.3.11 compatível com NestJS 12.2.0 e MikroORM PostgreSQL 7.2.5 nos smoke tests exercitados.

**Revisão de conformidade — PASS:** versões exatas, runtime Bun, TS estrito, containers reais, bancos/portas separados, role de aplicação sem superuser/createdb, Keycloak com banco próprio, filas FIFO e DLQ configuradas. Nenhum domínio financeiro antecipado. Dockerfile prepara o runtime; entrypoint final pertence à tarefa 11.

**Revisão de qualidade — PASS:** configuração e proteção de teste isoladas em módulos pequenos; erros não imprimem URLs com senha; scripts falham explicitamente; runner não ignora indisponibilidade; segredos versionados são somente fixtures locais declaradas. Inicialização usa hook ready.d documentado do LocalStack, evitando serviço one-shot incompatível com up --wait.

**Implementer Outcome:** DONE.

**Próxima ação:** tarefa 2, Money por TDD.

## Tarefa 2 — Money

**Status:** COMPLETE. **Execution Mode:** Delegated, agente money_tdd; revisão e validação independente pelo controlador.

**Intenção e arquivos:** valor monetário exato e imutável em src/shared/domain/money.ts, erro em domain-error.ts, testes em test/unit/money.test.ts.

**TDD:** 30 falhas comportamentais após scaffold importável; implementação com clone Decimal de precisão 31; GREEN com 30 testes e 80 asserções. Controlador repetiu teste focado e typecheck, ambos exit 0. Entradas rejeitam números, expoentes, negativos, escala variável e moedas malformadas. Cobertura de overflow positivo/negativo, sinais internos, rehydrate e isolamento da precisão global.

**Revisão de conformidade — PASS:** métodos do contrato completos; NUMERIC(30,2), escala fixa, construtor privado, factory, moeda explícita e domínio independente. Não usa number para cálculos monetários.

**Revisão de qualidade — PASS:** valor decimal é campo privado nativo, instância congelada, saída em objeto independente; precisão suficiente para soma de dois valores do limite; errors têm código estável. Sem achados pendentes.

**Implementer Outcome:** DONE. **Risco pendente:** round-trip PostgreSQL será comprovado na tarefa 5. **Próxima ação:** tarefa 3.

## Tarefa 3 — Wallet e lançamento imutável

**Status:** COMPLETE. **Execution Mode:** Inline.

**Arquivos:** src/wallets/domain/wallet.ts, ledger-entry.ts e respectivos testes unitários.

**TDD:** scaffolds importáveis produziram falhas; teste negativo do ledger foi fortalecido para exigir DomainError, obtendo 3/3 falhas antes da implementação. GREEN: 9 testes focados, 39 asserções; suíte completa 44 pass/0 fail, 132 asserções; typecheck passa.

**Conformidade — PASS:** abertura version 1, débito/crédito com lançamento correspondente, saldo insuficiente/moeda/zero/overflow sem alteração parcial, incremento somente quando há movimento, create valida equação e rehydrate só reconstrói. Garantias de persistência permanecem na tarefa 5.

**Qualidade — PASS:** campos nativos privados; Money imutável; snapshots de datas impedem alteração indireta; ledger congelado; wallet só muda depois que o lançamento foi validado. Nenhum achado pendente.

**Implementer Outcome:** DONE. **Próxima ação:** tarefa 4.

## Tarefa 4 — transações, regras e eventos

**Status:** COMPLETE. **Execution Mode:** Delegated, agente transaction_domain, com revisão independente do controlador.

**Arquivos:** wagering/domain (wager-transaction, wager-rules, failure-code), messaging/domain (integration-event, events), três testes unitários e fixture compartilhada.

**TDD:** 27 falhas comportamentais iniciais. Revisão encontrou transição PROCESSED sem referência interna para REFUND/ROLLBACK/WIN referenciado: 3 regressões RED/GREEN. Autorrevisão encontrou evento de saldo aceitando ledger reidratado zero: 1 regressão RED/GREEN. Resultado: 34 testes focados/104 asserções; suíte unitária 78/236; typecheck passa. Controlador repetiu focados e typecheck.

**Conformidade — PASS após correção:** estados terminais protegidos, vínculo resolvido obrigatório ao concluir operação referenciada, regras puras por tipo, moeda/wallet/rodada/provedor/valor, reversão única e código distinto para débito de reversão sem saldo. Eventos concretos com envelope estável e factories por estado.

**Qualidade — PASS:** datas copiadas, dados de eventos clonados/congelados, payload somente DTO, domínio sem infraestrutura. Decisões de regras não modificam wallet; terminal não pode ser reavaliado. Sem achados pendentes.

**Implementer Outcome:** DONE. **Próxima ação:** tarefa 5, constraints e migrations reais.

## Tarefa 5 — schema, migrations e mapeamento

**Status:** COMPLETE. **Execution Mode:** Inline para migrations/CLI; subtarefa de mapeamento delegada a persistence_mapping.

**Arquivos:** persistence/orm, records, schemas, mappers, duas migrations; scripts/migrate.ts; testes migrations/money-persistence/migration-cli; scripts no package.json e ignore de snapshot gerado.

**TDD:** infraestrutura foi restabelecida antes do RED válido. 6 IT falharam por tabelas ausentes; após migrations, 6 passam. Mapeamento teve 5 falhas iniciais e detectou uso incorreto de toString com moeda (SQLSTATE 22P02), corrigido por MoneyProps.amount. CLI teve 2 RED por ausência do comando e depois 2 GREEN. Revisão automática interrompeu gravação por limite de uso; retomada confirmou arquivos antes de continuar, sem contornar a revisão.

**Diagnóstico:** Bun 1.3.11 travou em matcher rejects.toThrow sobre erro PostgreSQL. Banco estava idle após responder, sem lock pendente. Testes passaram com catch e comparação explícita de SQLSTATE, fortalecendo a garantia de falha pela constraint esperada. Nenhuma constraint foi relaxada.

**Validação independente:** 11 IT de migrations/mapeamento, 57 asserções; typecheck passa. Up/down/up exercitado no banco wagering_test. Subtarefa também executou todos unitários mais seus IT: 85 pass/0 fail (80 unitários + 5 IT).

**Conformidade — PASS:** cinco tabelas, NUMERIC(30,2), checks contra negativo/NaN e equação, unicidades, FK de moeda/wallet no ledger, reversão única entre tipos, inbox composta, proteção UPDATE/DELETE/TRUNCATE com role restrita e triggers, migrations reversíveis. Money atravessa ORM como string, sem perda no valor máximo. Transações rejeitadas podem conservar moeda/player divergentes para auditoria; FKs compostas são aplicadas aos lançamentos efetivos, não impedem registrar rejeição.

**Qualidade — PASS:** EntitySchema separado do domínio, mappers explícitos rehydrate, metadados de retry/lease preservados, contexto de teste isolado e SQLSTATE específico. Snapshot automático desativado; migrations explícitas são a fonte do schema. Sem achados pendentes.

**Implementer Outcome:** DONE. **Próxima ação:** tarefa 6.

## Tarefa 6 — unidade de trabalho e abertura atômica

**Status:** COMPLETE. **Execution Mode:** Delegated, opening_atomicity; revisão independente pelo controlador.

**Arquivos:** porta shared/application/unit-of-work, adaptador persistence/unit-of-work, OpenWallet, Clock/Identifiers, IT wallet/atomicity, unitário open-wallet e helpers faults/assert-ledger.

**TDD:** 7 falhas comportamentais iniciais; GREEN com 7 IT. Revisão encontrou que uma exceção null era mascarada: regressão RED com TypeError, corrigida por guarda de tipo, seguida de GREEN. Acrescentados 3 unitários da orquestração. Validação do implementador: 83 unitários + 8 IT, 316 asserções. Controlador repetiu 11 testes focados, 76 asserções, e typecheck: todos passam.

**Conformidade — PASS:** contexto fork/transactional isolado, abertura positiva com OPENING, crédito e dois eventos na mesma transação, versão 1; zero sem lançamento/evento; duplicidade sem efeito adicional. Falhas após cada flush comprovam rollback real de carteira/transação/ledger/outbox. Assertion financeira usa uma consulta SQL para comparar saldo e soma do ledger sem number.

**Qualidade — PASS após correção:** porta sem tipos ORM, relógio/IDs injetáveis, helpers de falha apenas nos testes, classificação restrita à constraint de carteira duplicada, causa original preservada. Serialização da outbox limitada aos DTOs dos eventos concretos. Sem achados pendentes.

**Implementer Outcome:** DONE. **Próxima ação:** tarefa 7.
