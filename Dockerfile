FROM node:24-alpine
WORKDIR /app
COPY --chown=node:node package.json package-lock.json server.js store.js mongo-store.js ./
RUN npm ci --omit=dev
COPY --chown=node:node public ./public
RUN mkdir data && chown node:node data
USER node
ENV HOST=0.0.0.0 PORT=3100
EXPOSE 3100
VOLUME ["/app/data"]
CMD ["node", "server.js"]
