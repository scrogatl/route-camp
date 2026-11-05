# Production image: build the static bundle, then serve it with nginx.
# nginx also proxies /api to the backend, so the browser sees a single origin.
FROM node:24-alpine AS build

WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /srv/dist /usr/share/nginx/html

EXPOSE 80
