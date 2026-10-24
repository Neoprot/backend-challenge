# Checkpoint — execução do plano 2026-10-24-wagering

Plano aprovado pelo usuário. Execução na branch codex/wagering-processor, em worktree isolado a partir de 411c1bc.

## Controle de tarefas

| Tarefa | Estado |
| --- | --- |
| 1 — Bootstrap e ambiente real | COMPLETE |
| 2 — Money | COMPLETE |
| 3 — Wallet e ledger | IN_PROGRESS |
| 4–19 | PENDING |

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
