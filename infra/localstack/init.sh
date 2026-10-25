#!/bin/bash
set -euo pipefail
aws_local() { aws --endpoint-url "${AWS_ENDPOINT_URL:?Endpoint LocalStack obrigatório}" "$@"; }
aws_local sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null
dlq_url=$(aws_local sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)
dlq_arn=$(aws_local sqs get-queue-attributes --queue-url "$dlq_url" --attribute-names QueueArn --query Attributes.QueueArn --output text)
attributes=$(printf '%s' '{"FifoQueue":"true","ContentBasedDeduplication":"false","VisibilityTimeout":"30","ReceiveMessageWaitTimeSeconds":"10","RedrivePolicy":"{\"deadLetterTargetArn\":\"' "$dlq_arn" '\",\"maxReceiveCount\":5}"}')
aws_local sqs create-queue --queue-name wager-transactions.fifo --attributes "$attributes" >/dev/null
aws_local sqs create-queue --queue-name wager-events.fifo --attributes FifoQueue=true,ContentBasedDeduplication=false >/dev/null
printf 'Filas FIFO configuradas.\n'
