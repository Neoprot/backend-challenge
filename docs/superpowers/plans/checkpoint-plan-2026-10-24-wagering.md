# Checkpoint — execução do plano 2026-10-24-wagering

Plano aprovado pelo usuário. Execução na branch codex/wagering-processor, em worktree isolado a partir de 411c1bc.

## Controle de tarefas

| Tarefa | Estado |
| --- | --- |
| 1 — Bootstrap e ambiente real | COMPLETE |
| 2 — Money | IN_PROGRESS |
| 3–19 | PENDING |

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
