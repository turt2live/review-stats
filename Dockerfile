FROM node:14-alpine

WORKDIR /app
COPY . /app
RUN yarn install

VOLUME ["/app/tmp", "/app/html"]
ENTRYPOINT ["node", "index.js"]
