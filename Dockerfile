FROM node:20-alpine As development

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

###################
# BUILD FOR PRODUCTION
###################

FROM node:20-alpine As build

WORKDIR /usr/src/app

COPY --chown=node:node --from=development /usr/src/app/node_modules ./node_modules

COPY --chown=node:node silero_stream.js silero_stream.js

COPY --chown=node:node silero_vad.onnx silero_vad.onnx

COPY --chown=node:node index.js index.js

USER node

CMD [ "node", "index.js" ]