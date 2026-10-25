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
| 7 — Canonicalização e idempotência | COMPLETE |
| 8 — Processamento financeiro compartilhado | COMPLETE |
| 9 — Referências e reversão única | COMPLETE — aceite multiprocessos na tarefa 18 |
| 10 — Consultas e reconciliação | COMPLETE |
| 11 — Contrato HTTP e composição | COMPLETE |
| 12 — Keycloak e autorização | COMPLETE |
| 13 — Inbox e consumidor SQS | COMPLETE |
| 14 — Outbox recuperável | COMPLETE — aceite de processos na tarefa 18 |
| 15 — Retry, DLQ e ciclo de vida | COMPLETE — aceite de sinais SO na tarefa 18 |
| 16 — Reprocessamento de referências | COMPLETE |
| 17 — Logs, métricas e saúde | COMPLETE |
| 18 — Harness multiprocessos e races | COMPLETE |
| 19 — Documentação, reprodução e aceite | PENDING |

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

## Tarefa 7 — canonicalização e idempotência persistente

**Status:** COMPLETE. **Execution Mode:** Delegated, idempotency_tdd, com revisão independente do controlador.

**Arquivos:** canonical-payload, processing-result, porta idempotency, extensão PostgresUnitOfWork, testes canonical/idempotency.

**TDD:** 22 RED unitários e 5 RED de integração observados pelo implementador; GREEN ampliado para 22 unitários e 9 IT. Revisão fortaleceu a corrida: aguarda bloqueio real via pg_blocking_pids antes de liberar o primeiro commit. Controlador confirmou 31 pass/79 asserções; suíte unitária completa 105 pass/291 asserções; typecheck passa.

**Conformidade — PASS:** hash SHA-256 apenas dos campos de negócio validados; ordem recursiva estável, Money exato e OPENING externo recusado. Reserva, callback financeiro e resultado usam a mesma transação. Recovery de unicidade ocorre somente após rollback e em novo fork. Identidade e hash são comparados; conflitos retornam 409 sem novo efeito. Snapshot de resultado preservado, flag de replay derivada e ausente do JSON persistido.

**Qualidade — PASS:** classificação limitada às duas constraints esperadas, outras falhas propagadas. IT prova rollback de reserva/evento e reexecução posterior, estados pendente/rejeitado e rejeição de identidade divergente mesmo com hash forjado. Sem achados pendentes.

**Ambiente:** validação independente inicialmente encontrou ECONNREFUSED. Docker Desktop falhou por sockets temporários antigos em AppData/Local/Docker/run. Diretório preservado como run.stale-20261025, novo run criado; volumes mantidos. Docker voltou a responder e IT repetido com sucesso. Não foi tratado como RED de negócio.

**Implementer Outcome:** DONE. **Próxima ação:** tarefa 8.

## Tarefa 8 — processamento financeiro compartilhado

**Status:** COMPLETE. **Execution Mode:** Delegated, submit_financial, revisão independente do controlador.

**Arquivos:** SubmitWager, ApplicationError, portas/adaptador transacional, testes unitários submit-wager, IT wager/atomicity e dublês afetados.

**TDD:** 5 RED IT e 8 RED unitários; GREEN ampliado com timeout real, disputa de saldo, rollback e overflow. Revisão encontrou code não textual mascarado pelo classificador de retry; regressão RED/GREEN corrigida. Controlador repetiu 28 testes focados/161 asserções e typecheck com sucesso. Implementador executou suíte afetada de 145 testes/531 asserções.

**Conformidade — PASS:** BET/WIN/LOSS e rejeições persistem snapshot e eventos na mesma transação. LOSS não gera ledger/version; replay preserva saldo original. Lock por wallet sem lock global; retry de transação inteira limitado a três tentativas, reconstruindo domínio e preservando identidade/aceitação. Lock_timeout real retorna 503 sem reserva/efeitos; wallet inexistente 404. Moeda/player incompatíveis são rejeitados sem movimento; overflow desfaz tudo e preserva erro.

**Ajuste explícito:** o adaptador bloqueia a wallet antes do INSERT da reserva financeira. Inserir antes adquire KEY SHARE pela FK e pode gerar deadlock na promoção para FOR UPDATE entre operações distintas. Opção transacional preserva os testes diretos de unicidade da tarefa 7. IT coordenado aguarda dois locks reais antes de liberar a wallet; duas BET de 80 sobre 100 resultam em uma conclusão, uma rejeição, saldo 20 e versão 2.

**Qualidade — PASS:** domínio sem ORM, callback compartilhável por HTTP/SQS, erros permanentes preservados, helper de falha limitado aos métodos realmente suportados. Testes comprovam rollback de débito, crédito e rejeição depois dos flushes. Sem achados pendentes.

**Implementer Outcome:** DONE. **Limite desta etapa:** referências ainda aguardam; resolução pertence à tarefa 9. **Próxima ação:** tarefa 9.

## Tarefa 9 — referências e reversão única

**Status:** COMPLETE — implementação funcional nesta etapa e aceite com processos distintos concluído na tarefa 18. **Execution Mode:** Delegated, references_tdd, revisão independente pelo controlador.

**Arquivos:** FinancialSession, PostgresUnitOfWork, SubmitWager, dublês afetados, reference-fixture, IT references e concurrency/reversal.

**TDD:** 12 RED IT e 2 RED unitários; GREEN ampliado para 20 IT de referências, 11 unitários de submit e uma corrida com dois contextos. Controlador repetiu esses testes mais regras: 51 pass/208 asserções; typecheck passa. Implementador executou suíte afetada: 165 pass/638 asserções.

**Conformidade — PASS no escopo desta etapa:** lookup por provedor/id externo, referência interna persistida ao concluir, validação dos vínculos e valor integral, tipos permitidos, pendência sem referência/terminalidade, rejeição de referência rejeitada. Qualquer combinação de segunda reversão é recusada; rejeição não ocupa direito; ROLLBACK de REFUND não reabre BET. Insuficiência em reversão de WIN preserva saldo/ledger e permite outra tentativa futura. Pendência registra deadline de 24h e próxima tentativa desde aceitação, sem repetir evento em replay.

**Qualidade — PASS:** somente a wallet atual é bloqueada, evitando locks cruzados em referências divergentes. Regras permanecem puras; índice parcial continua como última garantia. Race aguarda dois locks reais no PostgreSQL e verifica um crédito, um evento Processed e um Rejected. Sem achados de código pendentes.

**Aceite complementar:** o harness da tarefa 18 repetiu a disputa entre REFUND e ROLLBACK com processos distintos e confirmou um único crédito. Worker de referências concluído na tarefa 16.

**Implementer Outcome:** DONE no escopo funcional. **Próxima ação:** tarefa 10, conforme sequência aprovada.

## Tarefa 10 — consultas, cursor e reconciliação

**Status:** COMPLETE. **Execution Mode:** Delegated, queries_tdd, revisão independente do controlador.

**Arquivos:** porta/adaptador WalletQueries, ReadWallet, ListLedger, ReconcileWallet, ledger-cursor, testes contracts/reconciliation.

**TDD:** 30 RED comportamentais iniciais, GREEN ampliado para 33 testes focados/64 asserções. Revisão acrescentou ano zero aceito por Date mas recusado pelo PostgreSQL: RED/GREEN. Controlador confirmou 32 focados/63 asserções antes da regressão e os 25 unitários finais depois dela; typecheck passa. Implementador executou suíte afetada anterior à última regressão: 159 pass/469 asserções.

**Conformidade — PASS:** contratos do README, Money string, wallet zero e valores grandes, 404 ausente, cursor opaco versionado com vínculo/UUID/data e limite 1–100/padrão 50. Keyset por data/id, precisão de seis casas do PostgreSQL preservada. Inserções novas não repetem páginas já lidas. Corrupção administrativa controlada é reportada com diferença signed e restaurada no finally, sem correção automática pela aplicação.

**Ajuste explícito:** reconciliação usa um SELECT agregado único, cujo snapshot MVCC inclui saldo e ledger de forma consistente; dispensa múltiplas leituras em transação REPEATABLE READ. IT com barreira após flush de saldo e antes de ledger demonstra snapshot antigo consistente antes do commit e novo consistente depois.

**Qualidade — PASS após refatoração:** ordenação qualificada pela coluna timestamp, evitando ordenar alias textual calculado e permitindo usar índice existente. Portas separadas do ORM, parâmetros SQL vinculados, cursor canônico e sem perda de microssegundos. Number é usado apenas para contagem de lançamentos, validada como inteiro seguro. Sem achados pendentes.

**Implementer Outcome:** DONE. **Próxima ação:** tarefa 11.

### Revisão independente da base financeira — tarefas 6–10

Skill requesting-code-review aplicada. Agente financial_review inspecionou a faixa f2230e8..37955770c6121ed3a4e96ae6e4707cbe77af9166 sem alterações locais da camada HTTP. Resultado: nenhum achado Critical, Important ou Minor que exigisse alteração. Executou 154 testes com sucesso: 60 IT/concorrência e 94 unitários. Não executou down/reset nem testes HTTP. Confirmou atomicidade, recuperação de unicidade, lock antes de INSERT, resultado original, reversão única, snapshot e cursor. A aprovação é limitada à base financeira; aceite multiprocessos continua pendente na tarefa 18.

## Tarefa 11 — contrato HTTP e composição NestJS

**Status:** COMPLETE no escopo desta etapa; autenticação obrigatória antes da entrega pertence à tarefa 12 seguinte. **Execution Mode:** Delegated, http_tdd, correções e revisão pelo controlador, qualidade independente por http_quality_review.

**Arquivos:** bootstrap/main/app.module/tokens, http/controllers/contracts/error.filter/readiness, porta/adaptador de consulta de transação, classificador compartilhado transient-failure, scripts start, testes contracts/error-filter/http.

**TDD:** 4 RED de contratos HTTP e 4 RED IT sobre scaffold Nest importável; GREEN. Revisão preservou os 25 testes anteriores de cursor que haviam sido substituídos. Controlador adicionou regressão para falhas transitórias de consulta: 4 RED recebendo500 em vez de503, corrigidas por classificador compartilhado com SubmitWager. Focados finais 49 pass/207 asserções; typecheck passa. Suíte integrada completa 78 pass/497 asserções, além do preflight3. Revisão independente executou34 unitários/82 asserções sem falhas.

**Conformidade — PASS:** todos endpoints do README, status201/200/202/400/404/409/422/503, chave obrigatória, UUID normalizado, Money string, enum/limites/campos desconhecidos validados em runtime. Controllers reutilizam casos de uso; consultas preservam providerId e snapshot original. Correlação segura precede parser JSON e aparece nos erros sanitizados. DI por tokens/factories explícitos, reflect-metadata no bootstrap; aplicação importável e tests em loopback/porta efêmera. Readiness verifica PostgreSQL e SQS reais, liveness separada.

**Qualidade — PASS:** parent e http_quality_review sem achados pendentes. Readiness passou a aguardar allSettled no fluxo normal/erro imediato, corrigindo fechamento do pool enquanto SELECT1 ainda estava em andamento. Nenhuma regra financeira duplicada. Classificação técnica compartilhada preserva erros desconhecidos como500 e não expõe SQL/credenciais.

**Riscos/follow-ups:** prazo de readiness limita resposta, mas cancelamento da consulta PostgreSQL após deadline pode ser aperfeiçoado na tarefa17. Guard global será conectado agora na tarefa12; API ainda não foi entregue ou publicada sem autenticação.

**Implementer Outcome:** DONE. **Próxima ação:** tarefa12.

## Tarefa 12 — autenticação e autorização Keycloak

**Status:** COMPLETE. **Execution Mode:** Delegated, keycloak_tdd; revisão de conformidade pelo controlador e qualidade independente identity_quality_review.

**Arquivos:** identity/principal/policy/verifier/guard/public, configuração e composição, controllers/filtro, helpers locais de tokens/admin, testes policy/verifier/config/error-filter/identity e adaptação HTTP sem bypass. Realm existente já atendia aos requisitos, sem alteração necessária.

**TDD:** RED de quatro políticas, quatro IT de identidade, dois filtros401/403 e configuração JWKS ausente. GREEN ampliado com claims/tipo/algoritmo, tokens reais e rotação. Revisão independente reproduziu falha Important: JWKS200 com JSON inválido ou201/204 era401 indevido. Código jose6.2.13 confirmado pelo controlador; regressão teve3 RED unitários e RED em proxy do JWKS real com nova chave. Correção delimitou resolvedor e exigiuHTTP200 sem duplicar parser/schema. Revisor repetiu29 unitários e aprovou a correção.

**Validação independente:** suíte IT completa89 pass/544 asserções mais preflight3 antes da última correção; após ela,48 focados/170 asserções incluindo identity/HTTP/rotação passaram. Suíte unitária final186 pass/468 asserções; typecheck passa.

**Conformidade — PASS:** APP_GUARD global nega por padrão; apenas health público. RS256, issuer/audience exatos, exp/sub/aud/iss/typ obrigatórios, typBearer e claims em runtime. URLs JWKS vêm da configuração confiável; OIDC_JWKS_URI permite rede interna mantendo issuer público. Token inválido401, sem papel/provedor divergente403, falha JWKS503 sanitizado. Provedores só submetem/leem próprias transações inclusiveID interno; admin consulta globalmente, mas submissão exige papel e identidade de provedor. Parâmetro providerId solicitado ao endpoint de token não altera claim do IdP.

**Qualidade — PASS após correção:** sem bypass de teste; ITHTTP usa tokens reais. Rotação cria componente RSA temporário, confirma kid diferente e valida tokens antigo/novo com cache; proxy só repassa JWKS real e injeta indisponibilidade/JSON inválido para nova chave. Cleanup de chave e cliente sem papéis emfinally comDELETE204. Teste de identidade aplica migrationsup independentemente, sem depender de outro arquivo.

**Limitação documentada:** cooldown de busca JWKS de5s limita abuso por kids desconhecidos; IT do guard aguarda essa janela na rotação. Nenhum achado pendente.

**Implementer Outcome:** DONE. **Próxima ação:** tarefa13.

## Tarefa 13 — inbox e consumidor SQS

**Status:** COMPLETE no escopo de pollOnce; supervisor/lifecycle/DLQ pertencem à tarefa15. **Execution Mode:** Delegated, inbox_tdd, revisão de conformidade pelo controlador e qualidade independente inbox_quality_review.

**Arquivos:** InboxMessage, SqsConsumer, contratos compartilhados sem dependência HTTP, contexto/opções idempotentes, PostgresUnitOfWork, testes inbox/atomicity e fixture FIFO exclusiva; nota técnica no README a consolidar19.

**TDD e limitação de sequência:** RED inicial unitário observado em scaffold importável (1fail/1pass); núcleo implementado depois. Os IT principais foram escritos após o núcleo e já passaram: não houve RED inicial desses IT. Revisões posteriores preservaram test-first: imutabilidade teve RED unitário; aceitação de ISO com offset/micros teve2 RED (unit e SQS real) antes do ajuste. Essa limitação procedural foi informada ao usuário; não invalida nem substitui os resultados reais de integração.

**Validação:** implementador executou205 unitários/510 asserções. Controlador repetiu49 testes/303 asserções incluindo inbox, atomicity, idempotency e HTTP, todos passam; typecheck passa. Revisor independente executou59 unitários sem falhas, leu IT sem concorrer com o controlador e não encontrou achados.

**Conformidade — PASS:** mesma SubmitWager do HTTP; inbox PK consumidor/messageId, hash do envelope validado inteiro (inclui horário e chave; ordem JSON irrelevante). Reserva/conclusão compartilham a SQL dos efeitos e snapshot; mensagem nova em replay cria só a nova inbox. Hash divergente propaga conflito e não recebe ack. DeleteMessage somente após commit, inclusive pendência aceita; erro antes do commit desfaz inbox/saldo/ledger/outbox. Redelivery e reinício confirmam um único efeito financeiro.

**Qualidade — PASS após ajustes:** lock advisory é por identidade, não global, com timeout local antes de qualquer lock; race observa pg_blocking_pids com barreira. Inbox imutável em runtime, datas copiadas, complete idempotente e reconstrução por tentativa. Contexto abortado não é reutilizado; recuperação de unicidade ocorre em nova transação incluindo inbox. Filas de teste exclusivas e cleanupfinally, sem purgar recursos globais.

**Follow-ups:** consumidor ainda é invocado explicitamente; bootstrap contínuo, renovação de visibilidade, DLQ e shutdown serão ligados na15. Aceite com processos distintos permanece na18. Sem achados de código pendentes.

**Implementer Outcome:** DONE. **Próxima ação:** tarefa14.

## Tarefa 14 — outbox recuperável e publishers

**Status:** COMPLETE — escopo funcional nesta etapa; morte/reinício de processos SO e harness concluídos na tarefa 18. **Execution Mode:** Delegated, outbox_tdd, conformidade pelo controlador e qualidade independente outbox_quality_review.

**Arquivos:** OutboxMessage, porta/store PostgreSQL, OutboxPublisher, consumidor demonstrativo de evento com inbox persistente, testes unit/outboxIT/publishers.

**TDD:** RED unitário e IT antes da implementação: claim vazio e retry não persistido. Revisão acrescentou RED para envelope duplicado/perda de version e correlationId, mutabilidade, envio sequencial e retorno prematuro do lote. GREEN final:213 unitários/554 asserções pelo implementador. Controlador repetiu12 focados/90 asserções (8unit,3IT reais,1race com barreiras) e typecheck. Revisor independente repetiu8 unitários/44 asserções, sem achados.

**Conformidade — PASS no escopo14:** claim curto com SKIPLOCKED e owner/lease no PostgreSQL, commit antes de rede comprovado por leitura externa e NOWAIT. Lease vencido permite retomada; owner incorreto/vencido não confirma nem altera tentativas. Publicação usa exatamente payload confirmado e eventId estável como dedupId; não apaga evento. Falha SQS real persiste backoff base1s/teto5min, sem descarte. Consumidor demonstrativo registra eventId/hash antes de ack e ignora duplicata, incluindo reentrega além da janela FIFO simulada somente pelo harness.

**Qualidade — PASS:** domínio usa campo privado nativo, cópias e freeze. Lote concorrente bounded, prazo de envio <= metade do lease, timer cancelado e allSettled aguardando todos envios antes de retorno/erro. Produção usa relógio PostgreSQL; Clock/IDs de escopo são usados só para isolação e teste determinístico, sem limpeza de eventos globais. Demo não executa efeito externo nem realimenta comandos.

**Aceite complementar:** a tarefa 18 confirmou publishers com owners distintos e recuperação após morte do processo entre SendMessage e publishedAt, preservando payload/eventId. Supervisor/bootstrap/shutdown concluídos na tarefa 15 e sinais de SO aceitos na tarefa 18.

**Implementer Outcome:** DONE no escopo funcional. **Próxima ação:** tarefa15.

## Tarefa 15 — retry, DLQ e ciclo de vida

**Status:** COMPLETE — escopo funcional nesta etapa e sinais reais de SO aceitos na tarefa 18. **Execution Mode:** Delegated, recovery_lifecycle_tdd; conformidade pelo controlador e qualidade independente recovery_quality_review.

**Arquivos:** worker-lifecycle, SqsConsumer, runtime/main de workers, SubmitWager.recordPermanentFailure, transient-failure, RecoveringPostgreSqlDriver/orm, scripts, testes retry/DLQ/recovery e helper de outage restrito.

**TDD:** RED unitário e IT antes do núcleo: classificação/backoff/DLQ/preflight, ausência de heartbeat, drain indevido e recebimento durante banco indisponível. Revisões acrescentaram RED para envio permanente àDLQ antesack/replayFAILED, RPCtravado, URLconfig cominput sensível e conexãoPGsemcode. Defeito reproduzido na stack: rollback em conexão morta deixava checkout preso e close não terminava em2s; regressionRED e depoisGREEN com extensão local do driver.

**Validação:** implementador executou226 unitários e117 integração/concorrência completos, incluindo migrations reversíveis, financeiros eIdP real. Controlador repetiu27 testes/171 asserções (retry,Dlq,recovery), todos passam em41s; typecheck passa. Revisor repetiu13 unitários/56 asserções e não encontrou achados. Dockerps independente confirmou PostgreSQL/LocalStack/Keycloak healthy após os testes.

**Conformidade — PASS no escopo15:** rejeição confirmadaack; transient nuncaFAILED, preflightDB com backoff evita esgotar5entregas. Malformada preserva corpo e identidade naDLQ, durableSend antesDelete. Permanente atribuível confirmaFAILED+resultado500+inbox numa nova SQL apósrollback semsaldo/ledger, depoisDLQ eack; falhaSend e replayFAILED preservamorigem/repetemenvio. 404/409 nãoalteramterminal original. Redrive5 testadoreal, duplicatasDLQ operacionais esperadas comsourceMessageIdestável, sem exatamenteumaentrega.

**Ciclo de vida:** heartbeatreal mantémvisibilidade, stopcancelalongpoll, drain aguardaou devolvevisibility0. RPCReceive temdeadline maiorquelongpoll; DLQ/acklimitados. Entrypoint start:workers iniciaHTTPautenticado+consumer+publisher; createApplication continuasemloops. Watchdog cobre drain+close, sai1 noprazo semafirmarSQLconcluída. Aceite dos sinais reais reservado18.

**Ajuste técnico da stack aprovado:** MikroORM7.2.5 usaControlledTransaction doKysely, que libera checkout somente após awaitrollback. Emconexãomorta oawaitfalha e impede release. SubclassePostgreSqlDriver decora createKyselyDialect/rollbackTransaction e permiteliberação somente para erros inequívocos deconexãomorta; erroORIGINAL continua propagado. Semnode_modules/privados/trocastack; PGpool descarta cliente nãoqueryable. ErrosSQLnormais,57014,40001,constraints e desconhecidos não são suprimidos. IT comqueda duranteSQL prova retomada única eclose<2s. Documentar workaround eversões na19.

**Trade-offs:** FAILED técnico não inventa novo evento; auditoria fica no estado/hash/resultado/inbox e observabilidade17. OutageSQS prova recuperação daoutboxPG emfila recriada; LocalStack atualsemPERSISTENCE não demonstra durabilidade interna dobroker. Helperconfere labels wagering-test/serviço antesstop e finallyrestaurahealthy+emissãorealKeycloak. Nenhum recurso dev/volume foi removido.

**Implementer Outcome:** DONE no escopo funcional. **Próxima ação:** tarefa16.

## Tarefa 16 — reprocessamento de referências

**Status:** COMPLETE. **Execution Mode:** Delegated, reference_worker_tdd. Conformidade revisada pelo controlador; qualidade independente por reference_quality_review.

**Arquivos:** porta e adaptador de referências, ReferenceWorker, PostgresUnitOfWork.runPending, SubmitWager.reprocessPending, integração no runtime, testes unitários e IT isolados em reference-worker.test.ts.

**TDD:** quatro falhas comportamentais antes do núcleo; regressões adicionais RED/GREEN para rollback e divergência entre os relógios da aplicação e do PostgreSQL. O teste com relógio da aplicação adiantado em sete dias demonstrou um claim válido sendo ignorado; a correção usa PostgreSQL como autoridade de claim, fence, TTL e backoff em produção. Relógio explícito permanece disponível para testes determinísticos.

**Validação:** implementador executou 229 unitários, 30 testes de referências/concorrência e sete de recovery sem outages. Controlador repetiu 33 testes de referências/concorrência, com 210 asserções, e sete de recovery, com 53 asserções; todos passaram. Typecheck passou. O revisor repetiu três unitários e não encontrou achados acionáveis.

**Conformidade — PASS:** seleção com lease e SKIP LOCKED confirmada antes de bloquear a carteira; ordem carteira → refresh/lock da pendência → validação de owner, estado e prazo. Reprocessamento atualiza a mesma transação e não cria inbox. Reutiliza as regras financeiras, preserva correlação e causalidade originais e atualiza o resultado persistido. Replay externo continua apenas leitura. Backoff começa em 1 s, tem teto de 5 min e respeita o deadline de 24 h; expiração emite uma única rejeição REFERENCE_EXPIRED, sem repetir PendingReference. Referência terminal não processada é rejeitada imediatamente.

**Qualidade — PASS:** porta na aplicação, processamento paralelo limitado e allSettled para drain completo. Testes comprovam retomada, owner obsoleto, liberação da seleção antes da espera pela carteira, rollback financeiro e preservação integral da inbox aceita. A fixture FAILED usa o caso de uso real em vez de alterar artificialmente um estado terminal. Runtime inclui o terceiro worker. Nenhum achado pendente.

**Implementer Outcome:** DONE. **Próxima ação:** tarefa 17.

## Tarefa 17 — logs, métricas e saúde

**Status:** COMPLETE. **Execution Mode:** Delegated, observability_tdd; revisão de conformidade pelo controlador e de qualidade por observability_quality_review.

**Arquivos:** observability, porta de observação na aplicação, composição HTTP, instrumentação dos casos de uso e dos três workers, sondas limitadas e testes de logging/observabilidade.

**TDD:** RED comportamental para endpoint de métricas inexistente, observação de commit/replay ausente, contexto do consumidor ausente e exclusão indevida de LOSS. A falha inicial de importação não foi contada como RED. A primeira correção de contagem dupla de latência antecedeu sua regressão específica; essa limitação de sequência está registrada, sem simular um RED posterior. Os dois achados P2 da revisão tiveram RED antes da correção: amostra artificial de duração em FAILED e perda de contexto nas falhas individuais dos workers. A segunda regressão também exigiu recuperar a correlação e os IDs originais da referência.

**Comportamento:** logs JSON usam lista positiva de campos e omitem tokens, segredos, corpos financeiros e mensagens arbitrárias de erro. Contexto por execução com AsyncLocalStorage; enriquecimento local por porta opcional, snapshots imutáveis e isolamento entre execuções. Falhas são observadas dentro do escopo de cada item, preservando o erro original. Não há marcador global por objeto Error; duas ocorrências do mesmo erro produzem dois diagnósticos.

**Métricas e saúde:** métricas textuais exigem administrador e têm labels enumeradas, sem IDs. Contadores financeiros só avançam após commit; replay conta como duplicata. Duração ausente não cria amostra e FAILED mede duração real. Contadores são locais ao processo; lag consulta a outbox e preserva a última leitura válida em caso de falha. Health permanece público: readiness verifica PostgreSQL/SQS com prazo e cancelamento, enquanto liveness independe deles. Cancelamento SQL pela API pública foi comprovado pela ausência da consulta em pg_stat_activity; o cancelamento do servidor é assíncrono. Kysely pode emitir diagnóstico próprio de cancelamento, sem SQL, credenciais ou payload.

**Evidência do implementador:** 240 unitários/690 asserções, três IT focados/46 asserções e 24 IT afetados/199 asserções passaram após os ajustes, além de typecheck e diff check. Antes deles, 69 IT afetados/516 asserções e a suíte completa de observabilidade com outages reais separados também passaram. Recursos exclusivos de teste foram restaurados.

**Validação final do controlador:** 240 unitários/690 asserções, oito IT de observabilidade/95 asserções e typecheck passaram. Os IT repetiram outages reais separados de SQS e PostgreSQL, com restauração dos serviços. Revisão de conformidade — PASS; revisão independente de qualidade — PASS após o fechamento dos dois P2, sem novos achados. O revisor também repetiu 240 unitários e typecheck.

**Implementer Outcome:** DONE. **Próxima ação:** tarefa 18.

## Tarefa 18 — harness multiprocessos e recuperação real

**Status:** COMPLETE. **Execution Mode:** Delegated, multiprocess_tdd, para harness nativo; controlador implementou os aceites Linux de sinais. Nenhuma alteração de produção foi necessária nesta etapa.

**TDD e aceites:** harness vazio retornava zero processos e a barreira liberava uma chegada prematuramente; RED antes das implementações. Proteções Linux tiveram três RED para projeto/rede/saúde e publicação de porta. Regressões adicionais demonstraram filho órfão após perder IPC e erro SQL do bloqueador convertido em timeout; ambos corrigidos após RED. Os cenários financeiros e de sinais exercitam comportamento de produção já implementado, sem inventar um RED histórico. Uma primeira falha Linux foi configuração inválida do próprio teste, waitTimeSeconds igual a zero; corrigida para o contrato de 1 a 20. Falha posterior de snapshot do cache Docker ocorreu antes dos testes; reconstrução com --no-cache resolveu, sem limpeza global ou reinício do daemon.

**Concorrência:** três processos Bun reais possuem PIDs, portas e sessões PostgreSQL distintos e ficam ready antes da barreira. Cinquenta BET iguais produzem uma nova operação e 49 replays; após reinício completo, outras cinquenta são replays do mesmo ID, mantendo um débito. Duas apostas de 80.00 sobre 100.00 resultam em um processamento, uma rejeição por saldo e saldo final 20.00. Carteira B confirma enquanto A continua bloqueada. REFUND e ROLLBACK disputam a mesma referência em processos diferentes, com um único crédito e a outra operação rejeitada. Barreiras e pg_blocking_pids comprovam contenção, incluindo a fila transitiva de bloqueio.

**Crashes:** supervisor mata o processo após sinal de commit e antes do ACK. Outro PID recebe a mensagem com receiveCount maior ou igual a dois; transação, inbox, débito e saldo permanecem únicos. Publishers independentes usam leases e owners diferentes. Morte após SendMessage e antes de publishedAt deixa o evento recuperável; novo PID aguarda o prazo PostgreSQL e publica o mesmo payload/eventId. Controles são módulos de teste por IPC e dependências injetáveis, sem endpoint ou flag de produção.

**Sinais Linux:** entrypoint real de workers executado na imagem Bun 1.3.11, com filas próprias e somente portas em loopback. SIGTERM durante SQL bloqueada aguarda liberação, confirma operação e ACK, preserva o segundo comando e sai com zero. Prazo de 1 s excedido resulta em exit 1 dentro da margem de observação da CLI; nenhuma transação/inbox parcial permanece. ReceiveMessage imediato comprova devolução da visibilidade antes da expiração natural; retomada confirma um único débito. Ledger é reconciliado e conexões do container encerrado desaparecem. Dois testes/26 asserções passaram no controlador.

**Isolamento e cleanup:** recursos Docker são inspecionados por labels do projeto wagering-test antes de uso; remoção só do container criado pela própria execução e suas filas. Sinais executam depois da suíte nativa porque o runtime completo faz scans globais de outbox/referências. Stderr dos filhos é coletado com limite; cleanup aninhado tenta encerrar processos, filas e ORM mesmo em falhas. Perda de IPC encerra o filho e impede órfãos.

**Revisão e validação final:** conformidade — PASS; qualidade independente — PASS após dois P2 com RED antes das correções. A perda do supervisor durante startup/imports agora encerra o filho, inclusive se o canal já estiver fechado. Falha de docker run após criar o container agora remove o recurso por nome e owner próprios; erros de cleanup são preservados. Runner completo passou: 14 testes nativos/97 asserções e dois Linux/26, em invocações sequenciais. Unitários: 245/706; typecheck passou. Controlador repetiu 244 unitários antes do último ajuste, quatro unitários Linux após ele e os aceites Linux reais; revisor repetiu os 245 unitários e typecheck. Nenhum processo filho ou container de sinais permaneceu ativo. Aceites complementares das tarefas 9, 14 e 15 encerrados.

**Implementer Outcome:** DONE. **Próxima ação:** tarefa 19.
