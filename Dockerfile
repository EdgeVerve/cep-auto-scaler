FROM registry.oecloud.local/alpine-node-docker
EXPOSE 8081
COPY server.js  /
COPY node_modules /node_modules
CMD node server.js