# The WhatsApp bot's task image (#236). Built with the REPO ROOT as context (the CDK stack
# passes it), because the bot is a pnpm workspace member that inlines @whippin/shared —
# the root .dockerignore whitelists exactly the files this needs.
#
# Two stages, one layout (/app): install everything and bundle, then reinstall production
# dependencies only and copy the bundle over. `pnpm` comes from corepack at the version the
# root package.json pins.

FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @whippin/whatsapp-bot...
RUN pnpm --filter @whippin/whatsapp-bot build

FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /app
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml ./
COPY --from=build /app/packages/ ./packages/
RUN rm -rf node_modules packages/*/node_modules \
  && pnpm install --frozen-lockfile --prod --filter @whippin/whatsapp-bot... \
  && pnpm store prune
ENV NODE_ENV=production \
    BOT_GROUPS_DIR=/app/packages/whatsapp-bot/groups
USER node
CMD ["node", "packages/whatsapp-bot/dist/main.mjs"]
