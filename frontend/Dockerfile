# BEGIN LICENSE HEADER
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
#
# Part of route-camp. Licensed under the Apache License, Version 2.0;
# see the LICENSE and NOTICE files in the repository root.
# Redistributions must retain this notice and the NOTICE file.
#
# Commit history (date time tz | author <email> | commit | message):
#   2026-11-05 13:54:45 -0500 | Scott Rogers <scott@scottandrewrogers.com> | f01884b | Serve a production build with nginx; keep the Vite dev stack as an override
#   2026-11-05 13:54:45 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 40b262d | Add plans UI, GPX track import report and replace confirmation
#   2026-11-05 13:14:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 6223ce0 | Add Vite + MapLibre frontend
# END LICENSE HEADER
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
