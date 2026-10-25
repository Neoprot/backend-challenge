param([string]$ApiBaseUrl = 'http://localhost:3000')
$ErrorActionPreference = 'Stop'

try {
  $endpoint = [Uri]$ApiBaseUrl
  if (-not $endpoint.IsAbsoluteUri -or $endpoint.Scheme -ne 'http' -or
      $endpoint.Host -notin @('localhost', '127.0.0.1', '[::1]', '::1') -or
      $endpoint.UserInfo -or $endpoint.Query -or $endpoint.Fragment -or $endpoint.AbsolutePath -ne '/') {
    throw 'invalid'
  }
} catch { throw 'ApiBaseUrl exige HTTP loopback sem credenciais, query, fragmento ou prefixo.' }

$api = $endpoint.AbsoluteUri.TrimEnd('/')
$issuer = 'http://localhost:8180/realms/wagering'
$bounded = @{TimeoutSec=5; MaximumRedirection=0}
$admin = (Invoke-RestMethod @bounded -Method Post -Uri "$issuer/protocol/openid-connect/token" -Body @{grant_type='client_credentials';client_id='operations-console';client_secret='local-operations-only'}).access_token
$provider = (Invoke-RestMethod @bounded -Method Post -Uri "$issuer/protocol/openid-connect/token" -Body @{grant_type='client_credentials';client_id='provider-aurora';client_secret='local-aurora-only'}).access_token
$adminHeaders = @{Authorization="Bearer $admin"}
$player = [guid]::NewGuid().ToString()
$opening = @{playerId=$player;initialBalance=@{amount='100.00';currency='BRL'}} | ConvertTo-Json -Depth 8
$wallet = Invoke-RestMethod @bounded -Method Post -Uri "$api/wallets" -Headers $adminHeaders -ContentType 'application/json' -Body $opening
$key = [guid]::NewGuid().ToString()
$providerHeaders = @{Authorization="Bearer $provider";'Idempotency-Key'=$key}
$bet = @{providerId='aurora';externalTransactionId=[guid]::NewGuid().ToString();playerId=$player;walletId=$wallet.id;roundId='round-demo';gameId='game-demo';kind='BET';money=@{amount='25.00';currency='BRL'}} | ConvertTo-Json -Depth 8
$first = Invoke-RestMethod @bounded -Method Post -Uri "$api/wagering/transactions" -Headers $providerHeaders -ContentType 'application/json' -Body $bet
$replay = Invoke-RestMethod @bounded -Method Post -Uri "$api/wagering/transactions" -Headers $providerHeaders -ContentType 'application/json' -Body $bet
$ledger = Invoke-RestMethod @bounded -Uri "$api/wallets/$($wallet.id)/ledger?limit=50" -Headers $adminHeaders
$reconciliation = Invoke-RestMethod @bounded -Method Post -Uri "$api/wallets/$($wallet.id)/reconciliation" -Headers $adminHeaders
if ($first.idempotentReplay -ne $false -or $replay.idempotentReplay -ne $true -or $first.transactionId -ne $replay.transactionId -or
    $reconciliation.consistent -ne $true -or $reconciliation.checkedEntries -ne 2 -or $reconciliation.storedBalance.amount -ne '75.00') {
  throw 'Demonstração HTTP não confirmou replay, saldo e ledger esperados.'
}
[ordered]@{walletId=$wallet.id;first=$first;replay=$replay;ledger=$ledger;reconciliation=$reconciliation} | ConvertTo-Json -Depth 12
