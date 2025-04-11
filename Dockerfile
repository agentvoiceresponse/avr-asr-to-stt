FROM node:20-slim AS development

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

###################
# BUILD FOR PRODUCTION
###################

FROM node:20-slim AS build

WORKDIR /usr/src/app

# Install required system libraries for onnxruntime-node
RUN apt-get update && apt-get install -y --no-install-recommends \
    libc6 \
    && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node --from=development /usr/src/app/node_modules ./node_modules

COPY --chown=node:node silero_stream.js silero_stream.js

COPY --chown=node:node silero_vad.onnx silero_vad.onnx

COPY --chown=node:node index.js index.js

USER node

CMD [ "node", "index.js" ]