# The keeper on its own, for a host that stays up (Railway, Fly, a VPS): records outcomes as a backstop and, while gas
# is at or below 0.3 gwei, keeps one market open. Build from the repository root:
#
#   docker build -f keeper/Dockerfile -t zolt-keeper .
#   docker run -e KEEPER_PRIVATE_KEY=0x… -e ODDS_ADDRESS=0xaC86B04D48033b2454b132EDED596E0c61A5b097 zolt-keeper
#
# The key is read from the environment only; nothing in the image holds one. The keeper spends the key's ETH on gas
# (about 0.0003 ETH a day when the chain is quiet) and stops sending at a 0.0005 ETH reserve.
FROM node:22-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY keeper/package.json keeper/package-lock.json* ./keeper/
RUN cd keeper && npm install --omit=dev --no-audit --no-fund
COPY keeper/odds-keeper.cjs keeper/odds-logic.cjs keeper/status.cjs ./keeper/
COPY research/rpc.cjs ./research/
ENV NODE_ENV=production
CMD ["sh", "-c", "cd keeper && node odds-keeper.cjs --odds \"$ODDS_ADDRESS\" --send --auto-open --max-open 1 --window 1 --open-max-gwei 0.3 --interval 5"]
