# web — Next.js 15 marketplace (standalone server, stateless: scales out).
# Build from the REPO ROOT (it imports the shared/ workspace):
#   docker build -f web/Dockerfile \
#     --build-arg NEXT_PUBLIC_TICKETD_URL=https://api.gamevault.example \
#     --build-arg NEXT_PUBLIC_SUBGRAPH_URL=https://… \
#     --build-arg NEXT_PUBLIC_WC_PROJECT_ID=… \
#     -t gamevault/web:<tag> .
# NEXT_PUBLIC_* values are baked into the browser bundle at build time:
# they are public by nature (no secret goes here).

FROM node:22.12-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY shared/package.json shared/
COPY web/package.json web/
RUN npm ci --workspace @gamevault/web --workspace @gamevault/shared --include-workspace-root
COPY tsconfig.node.json ./
COPY shared shared
COPY web web
ARG NEXT_PUBLIC_TICKETD_URL
ARG NEXT_PUBLIC_SUBGRAPH_URL
ARG NEXT_PUBLIC_WC_PROJECT_ID
ENV NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_TICKETD_URL=$NEXT_PUBLIC_TICKETD_URL \
    NEXT_PUBLIC_SUBGRAPH_URL=$NEXT_PUBLIC_SUBGRAPH_URL \
    NEXT_PUBLIC_WC_PROJECT_ID=$NEXT_PUBLIC_WC_PROJECT_ID
RUN npm run build --workspace @gamevault/web

FROM node:22.12-bookworm-slim
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# standalone output = server + only the node_modules it traces
COPY --from=build --chown=node:node /app/web/.next/standalone ./
COPY --from=build --chown=node:node /app/web/.next/static ./web/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "web/server.js"]
