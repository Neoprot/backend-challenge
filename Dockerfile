FROM oven/bun:1.3.11 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM oven/bun:1.3.11
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
USER bun
CMD ["bun", "src/workers/main.ts"]
