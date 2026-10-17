FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8000 \
    DATA_DIR=/app/data

# Zero runtime dependencies: just the app.
COPY package.json ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "src/server.js"]
