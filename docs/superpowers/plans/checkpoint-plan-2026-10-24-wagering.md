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
| 9 — Referências e reversão única | PARTIAL — aceite multiprocessos na tarefa 18 |
| 10 — Consultas e reconciliação | COMPLETE |
| 11 — Contrato HTTP e composição | COMPLETE |
| 12 — Keycloak e autorização | COMPLETE |
| 13 — Inbox e consumidor SQS | IN_PROGRESS |
| 14–19 | PENDING |

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

**Status:** PARTIAL, implementação funcional concluída; aceite com processos distintos explicitamente reservado à tarefa 18 no plano. **Execution Mode:** Delegated, references_tdd, revisão independente pelo controlador.

**Arquivos:** FinancialSession, PostgresUnitOfWork, SubmitWager, dublês afetados, reference-fixture, IT references e concurrency/reversal.

**TDD:** 12 RED IT e 2 RED unitários; GREEN ampliado para 20 IT de referências, 11 unitários de submit e uma corrida com dois contextos. Controlador repetiu esses testes mais regras: 51 pass/208 asserções; typecheck passa. Implementador executou suíte afetada: 165 pass/638 asserções.

**Conformidade — PASS no escopo desta etapa:** lookup por provedor/id externo, referência interna persistida ao concluir, validação dos vínculos e valor integral, tipos permitidos, pendência sem referência/terminalidade, rejeição de referência rejeitada. Qualquer combinação de segunda reversão é recusada; rejeição não ocupa direito; ROLLBACK de REFUND não reabre BET. Insuficiência em reversão de WIN preserva saldo/ledger e permite outra tentativa futura. Pendência registra deadline de 24h e próxima tentativa desde aceitação, sem repetir evento em replay.

**Qualidade — PASS:** somente a wallet atual é bloqueada, evitando locks cruzados em referências divergentes. Regras permanecem puras; índice parcial continua como última garantia. Race aguarda dois locks reais no PostgreSQL e verifica um crédito, um evento Processed e um Rejected. Sem achados de código pendentes.

**Risco/aceite pendente:** dois contextos no mesmo processo não substituem o harness multiprocessos. Repetir cenário na tarefa 18 antes de marcar COMPLETE e entregar. Worker de referências pertence à tarefa 16.

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
