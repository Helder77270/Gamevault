# ticketd — ticket service (Node 22, TypeScript run natively, SQLite).
# Build from the REPO ROOT (it imports the shared/ workspace):
#   docker build -f ticketd/Dockerfile -t gamevault/ticketd:<tag> .
#
# State lives in /app/ticketd/data (SQLite + WAL, avatars, build cache):
# mount a persistent volume there. Secrets come from the environment
# (Kubernetes Secret), never from the image.

FROM node:22.12-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY shared/package.json shared/
COPY ticketd/package.json ticketd/
# Only the two workspaces this service needs, production deps only
RUN npm ci --omit=dev --workspace @gamevault/ticketd --workspace @gamevault/shared --include-workspace-root=false \
 && npm cache clean --force

FROM node:22.12-bookworm-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY shared/package.json shared/
COPY shared/src shared/src
COPY ticketd/package.json ticketd/
COPY ticketd/src ticketd/src
RUN mkdir -p ticketd/data && chown -R node:node ticketd/data
USER node
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
WORKDIR /app/ticketd
CMD ["node", "--experimental-sqlite", "--experimental-strip-types", "src/server.ts"]
