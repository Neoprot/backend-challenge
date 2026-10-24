# Processador distribuído de apostas — especificação

Data: 24/10/2026. Fonte de requisitos: README.md deste repositório.

## Decisões aprovadas

Implementar o desafio integralmente, com código original, sem consultar ou reproduzir a implementação do fork sugerido. Preservar os nomes e contratos exigidos pelo enunciado. Integrar Keycloak desde a primeira entrega. Usar locks por wallet. Impedir qualquer segunda reversão concluída da mesma transação, independentemente de ser REFUND ou ROLLBACK. Desenvolver por TDD obrigatório, com testes unitários e de integração (IT).

Esta especificação registra o desenho aprovado na conversa e será revisada pelo usuário antes do plano executável. Não contém implementação.

## Escopo e tecnologias

Bun 1.x como runtime, gerenciador e executor de testes; TypeScript estrito; NestJS; PostgreSQL; MikroORM; AWS SQS em LocalStack; Docker Compose; migrations versionadas com up/down. Keycloak será o provedor de identidade. Bibliotecas auxiliares deverão servir a essas tecnologias, sem substituí-las. Versões compatíveis e exatas serão verificadas na documentação oficial via Context7 durante o planejamento e fixadas no lockfile e nas imagens.

Não incluir frontend, autenticação própria, Redis, outro broker ou outro ORM. Dashboard, OpenTelemetry, partidas dobradas e testes de carga são opcionais e não entram nesta entrega. Documentar setup no README e decisões, limitações e trade-offs no ARCHITECTURE.md.

## Arquitetura e responsabilidades

Uma aplicação com módulos de wallet, transações, mensageria, identidade e observabilidade. Domínio em classes encapsuladas, sem decorators NestJS nem tipos do ORM; construtores privados/protegidos, factories de criação e rehydrate para reconstruir estado persistido. Adaptadores de persistência fazem o mapeamento explícito.

Portas delimitam persistência transacional, relógio, geração de identificadores, identidade e publicação. HTTP e SQS invocam o mesmo caso de uso financeiro. As entradas traduzem seus contratos; as regras pertencem ao domínio e à aplicação. Workers executam consumo SQS, publicação da outbox e reprocessamento de referências pendentes. Todas as funções devem operar com três ou mais instâncias.

## Dinheiro e movimentação

Money é imutável e usa aritmética decimal exata. Entradas e saídas usam strings decimais com duas casas; rejeitar entrada numérica, notação científica, NaN, Infinity, vazio, mais de duas casas e negativos externos. Não arredondar silenciosamente entradas inválidas. Negativos internos são permitidos para cálculos como diferença de reconciliação. Usar NUMERIC(30,2) no banco e limites equivalentes no domínio, sem conversão monetária por number.

Operação local em BRL, mantendo moeda no modelo e validação de incompatibilidade. Wallet única por playerId e currency, saldo não negativo, version inicial 1 e incremento somente quando o saldo muda. Abertura positiva gera OPENING e crédito no ledger na mesma transação SQL, preservando version 1; abertura zero não gera lançamento nem evento de mudança de saldo.

BET debita, WIN credita, LOSS apenas registra resultado. LOSS exige valor zero; BET, WIN, REFUND e ROLLBACK exigem valor positivo. WIN pode informar referência a BET; quando informada, validar os mesmos vínculos e aguardar se ausente. Não exigir referência para WIN ou LOSS. OPENING é proibido nas entradas externas.

REFUND referencia BET; ROLLBACK referencia BET, WIN ou REFUND. Referências devem estar PROCESSED e corresponder a provedor, jogador, wallet, moeda e rodada. A reversão tem o valor integral da referência. Referência terminal não processada causa rejeição. Referência existente ainda pendente permanece aguardando. Referência a si mesma é inválida.

Uma referência admite somente uma reversão PROCESSED entre os dois tipos; tentativas rejeitadas não consomem esse direito. ROLLBACK de REFUND continua permitido, pois reverte outra transação; não reabre o direito de reverter a BET original. Reversão com débito insuficiente usa REVERSAL_INSUFFICIENT_FUNDS, distinto de INSUFFICIENT_FUNDS de BET.

## Transação SQL e concorrência

Usar transação MikroORM com contexto isolado por execução e lock pessimista na wallet. Ordenar aquisições de lock de forma consistente entre HTTP, consumidor e reprocessador. Nunca bloquear todas as wallets com um lock global. Wallets diferentes devem progredir em paralelo.

Na unidade atômica: resolver idempotência, bloquear wallet, avaliar operação, persistir estado e resultado, movimentar saldo e ledger quando aplicável, registrar inbox quando SQS e enfileirar eventos na outbox. Rejeições de negócio persistem sem movimentação financeira. Falha técnica antes do commit desfaz a unidade inteira. Ack e publicação acontecem somente depois do commit.

Unicidades no schema: wallet por jogador/moeda; transação por provedor/id externo; idempotency key; inbox por consumidor/messageId; ledger por wallet/transação; reversão concluída por referência, com índice único parcial abrangendo REFUND e ROLLBACK. Constraints verificam saldo não negativo, valores e equação balanceBefore ± amount = balanceAfter, chaves estrangeiras e coerência das moedas. Ledger protegido contra UPDATE/DELETE e TRUNCATE pela combinação de permissões da role de execução e proteção no banco; migrations usam role separada. A atomicidade saldo/ledger será demonstrada em IT.

Deadlocks, timeouts e falhas transitórias têm retries limitados; nunca converter falha temporária do banco em rejeição financeira definitiva. O teste obrigatório com saldo 100.00 e duas BET de 80.00 deve resultar em um débito, uma rejeição e saldo 20.00.

## Idempotência e estados

Header Idempotency-Key obrigatório no HTTP; campo equivalente no SQS. Hash SHA-256 de JSON canônico dos campos de negócio, ordenando chaves recursivamente e normalizando Money; excluir metadados de transporte e a própria chave. Persistir os campos que permitem devolver status HTTP, resultado financeiro e saldo observado originalmente.

Mesmo identificador e mesmo conteúdo retornam a operação existente, sem efeitos adicionais. Mesma chave com conteúdo diferente é conflito. Mesmo provedor/id externo com outra chave não cria nova operação: retornar conflito de identidade e documentar o contrato. Inbox duplicada com conteúdo divergente também é conflito auditável, nunca descarte silencioso.

Estados: PENDING pode passar a PENDING_REFERENCE, PROCESSED, REJECTED ou FAILED; PENDING_REFERENCE pode permanecer aguardando ou chegar a PROCESSED, REJECTED ou FAILED. PROCESSED, REJECTED e FAILED são terminais. Replays de resultado terminal retornam o saldo original; enquanto pendente, a consulta e o replay informam o estado persistido atual, sem inventar saldo de processamento.

Reprocessamento de referências com backoff exponencial: base 1 segundo, teto 5 minutos e prazo máximo de 24 horas desde a aceitação. Persistir tentativa e próxima execução para sobreviver a reinícios. Ao expirar, rejeitar com REFERENCE_EXPIRED e evento correspondente. Workers concorrentes reivindicam trabalho com lease e SKIP LOCKED, liberando o lock de seleção antes de executar o fluxo que bloqueia a wallet.

## HTTP e identidade

Implementar todos os endpoints do README: criação e consulta de wallet, ledger paginado, consulta de transação por identificador interno ou provedor/id externo, submissão, reconciliação, liveness e readiness. Cursor opaco por chave estável composta, sem paginação por offset; validar formato e limite entre 1 e 100, padrão 50.

Respostas: 201 criação de wallet; 200 processamento concluído, consulta, reconciliação e replay bem-sucedido; 202 processamento pendente; 400 payload inválido; 401 identidade ausente/inválida; 403 falta de permissão; 404 recurso ausente; 409 duplicidade/conflito de identidade ou payload; 422 rejeição de negócio; 503 infraestrutura temporariamente indisponível. Replays de rejeições preservam o código original. Erros contêm código estável e correlationId, sem stack ou segredo.

Keycloak no Compose com realm de desenvolvimento e clientes de serviço por provedor, usando client_credentials. Validar assinatura, expiração, issuer e audience do access token; obter chaves via JWKS e suportar rotação. providerId vem de claim configurada pelo IdP, não da confiança no corpo. Provedor pode submeter e consultar somente suas transações; divergência entre token, corpo ou rota resulta em 403. Criação, leitura global de wallets/ledger e reconciliação exigem papel administrativo. Consultar transação por ID interno também aplica autorização ao provedor proprietário.

Health permanece público. SQS é canal interno confiável, mas valida identidade do provedor e vínculos do domínio. Segredos entram via configuração; nenhuma credencial real é versionada ou registrada em log. Exemplos locais devem ser identificados como exclusivos de desenvolvimento. Não criar UI de login nem banco próprio de senhas.

## Mensageria e recuperação

Filas de entrada e DLQ: wager-transactions.fifo e wager-transactions-dlq.fifo. MessageGroupId por wallet é otimização; correção depende do banco. Configurar visibility timeout com renovação para execução longa. Erro de negócio terminal recebe ack após persistência; falha transitória tenta novamente com backoff até cinco recebimentos; esgotamento segue para DLQ. Mensagem estruturalmente inválida segue para DLQ, sem fabricar transação financeira. Persistir FAILED quando houver identidade transacional válida e falha técnica permanente registrável; se o banco estiver indisponível, preservar a mensagem para recuperação.

Publicar eventos em fila de integração separada para não realimentar a fila de comandos. Outbox com reivindicação por lease, SKIP LOCKED, tentativas persistidas e marcação de publicado condicionada à posse da reivindicação. Não manter a transação financeira aberta durante envio à AWS. Lease expirado permite recuperação por outra instância; falhas de publicação continuam com backoff limitado em frequência, sem descartar evento confirmado. Duplicatas após envio e antes da confirmação local são esperadas; eventId permanece estável e a demonstração inclui consumidor idempotente.

Eventos tipados derivam de IntegrationEvent abstrata: WagerTransactionProcessed, WagerTransactionRejected, WalletBalanceChanged e WagerTransactionPendingReference. Envelope versionado inclui identificadores de correlação e causalidade, data ISO e Money serializado. LOSS publica Processed sem BalanceChanged; rejeições não publicam BalanceChanged. Persistir evento de pendência na transição, sem gerar outro a cada polling.

SIGTERM interrompe novas buscas, aguarda operações em andamento dentro de prazo e devolve visibilidade quando necessário. SIGKILL pode impedir limpeza; redelivery e leases asseguram recuperação. Testes controlam a janela após commit/antes do ack e após commit/antes da publicação, sem temporizações arbitrárias como única sincronização.

## Reconciliação e observabilidade

Reconstruir saldo a partir dos lançamentos com snapshot consistente em relação ao saldo materializado. Responder saldo armazenado, calculado, diferença, quantidade e consistência. Não corrigir divergência automaticamente; gerar log e métrica.

Logs JSON com correlationId, messageId, transactionId, walletId e providerId quando disponíveis; sem tokens, segredos ou payload financeiro completo. Métricas para transações por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência e divergência de reconciliação, sem identificadores de alta cardinalidade como labels. Endpoint de métricas protegido administrativamente. Liveness verifica processo; readiness verifica PostgreSQL e SQS, com timeout e diagnóstico sanitizado.

## Regra obrigatória de TDD e segurança por testes

O plano de implementação deverá repetir o ciclo abaixo em cada tarefa de comportamento, incluindo correções posteriores:

1. Escrever teste observável que descreva o requisito ou reproduza o defeito.
2. Executar o teste e registrar RED: falha pelo comportamento ausente/incorreto. Erro de ambiente ou dependência não conta como RED válido.
3. Implementar somente o necessário para GREEN.
4. Executar novamente o teste e a suíte afetada.
5. Refatorar mantendo GREEN, incluindo checagem de tipos.
6. Revisar aderência ao requisito antes de revisar qualidade e concluir a tarefa.

Testes unitários cobrem regras e transições isoladas. Toda fronteira de banco, transporte ou autenticação alterada exige também IT com os serviços reais em containers. Não substituir PostgreSQL, SQS ou Keycloak por mocks nos testes que demonstram suas garantias. Dublês podem ser usados em testes unitários e pontos de injeção de falha, sem substituir a integração avaliada.

Infraestrutura inicial pode ser preparada para tornar os testes executáveis; não implementar antecipadamente comportamentos de negócio sob essa exceção. Mudanças somente documentais não exigem testes artificiais. Nenhuma tarefa funcional será considerada concluída com teste obrigatório ignorado, falhando ou não executado. Bloqueios de ambiente devem ser registrados como validação pendente; jamais apresentados como sucesso. Testes reduzem risco e demonstram os cenários exercitados, sem prometer ausência absoluta de defeitos.

### Matriz mínima de verificação

| Área | Testes unitários | Testes de integração e concorrência |
| --- | --- | --- |
| Money | Precisão, escala, entradas inválidas, imutabilidade, sinais e moedas | Round-trip NUMERIC sem perda e rejeição de limites inválidos |
| Wallet e ledger | Débito/crédito, saldo insuficiente, version e equação do lançamento | Abertura atômica, unicidade, CHECKs, proibição de mutação do ledger e rollback SQL |
| Transações | Todos os tipos, referências, terminais e códigos de falha | HTTP/SQS com mesma regra, referências fora de ordem, expiração e recuperação |
| Idempotência | Canonicalização, divergência e resposta original | 50 duplicatas paralelas, conflitos entre instâncias e replay após reinício |
| Reversões | Valor/vínculos/tipos, segunda reversão e débito insuficiente | REFUND contra ROLLBACK concorrentes: no máximo uma conclusão e um lançamento |
| Inbox/outbox | Backoff, transições e envelope | Atomicidade conjunta, ack após commit, dois publishers, leases e consumidor idempotente |
| Falhas | Classificação transitória/permanente/negócio | Indisponibilidade real, retry, DLQ, shutdown e queda entre commit/ack/publicação |
| Concorrência | Regras isoladas não substituem races | Três processos, disputa de saldo e progresso independente de wallets diferentes |
| Keycloak | Extração de identidade e política de autorização | Tokens reais; ausência, expiração, issuer/audience incorretos, outro provedor e papel insuficiente |
| Consultas | Cursor inválido, códigos HTTP e formatação | Paginação estável, autorização de recurso, reconciliação consistente e health |
| Observabilidade | Remoção de campos sensíveis e classificação | Métricas e logs correspondentes a falhas, retries, rejeições e divergência |

Todos os cenários financeiros verificam wallet.balance igual ao saldo reconstruído pelo ledger, quantidade de lançamentos e ausência de efeito duplicado. Testes concorrentes devem usar barreiras/sinais de coordenação e processos reais, com banco e filas isolados por execução e cleanup determinístico.

## Critérios de entrega e sequência do plano

O plano detalhado deverá organizar tarefas pequenas: ambiente e harness; Money e domínio; migrations e persistência; abertura e reconciliação; transações e idempotência; referências e reversões; HTTP e Keycloak; consumidor/inbox; publisher/outbox; recuperação e referências pendentes; observabilidade; suíte multiprocessos e documentação. Cada tarefa informa arquivos, teste RED, implementação GREEN, refatoração e comando de verificação.

Expor comandos Bun para typecheck, testes unitários, IT e concorrência. Docker Compose deve iniciar serviços com health checks e permitir três instâncias da aplicação, sem colisões de portas fixas. Migrations up/down/up serão verificadas em banco descartável. A entrega inclui exemplos HTTP/SQS, obtenção de token local, configuração, execução e diagnóstico de falhas, além das decisões desta especificação.

Aceite final: requisitos obrigatórios do README rastreados a testes; suítes unitária, IT e concorrência executadas com sucesso; documentação reproduzível; nenhuma alteração baseada no fork; resultados reais e limitações reportados com honestidade.
