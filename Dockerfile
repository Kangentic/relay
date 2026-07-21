# --- build stage ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

# --- runtime stage ---
FROM node:22-bookworm-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/Kangentic/relay" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.title="@kangentic/relay" \
      org.opencontainers.image.description="Blind WebSocket rendezvous relay for the Kangentic mobile companion."
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
