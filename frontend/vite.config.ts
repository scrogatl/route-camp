// BEGIN LICENSE HEADER
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Scott Rogers <scott@scottandrewrogers.com>
//
// Part of route-camp. Licensed under the Apache License, Version 2.0;
// see the LICENSE and NOTICE files in the repository root.
// Redistributions must retain this notice and the NOTICE file.
//
// Commit history (date time tz | author <email> | commit | message):
//   2026-11-05 13:14:25 -0500 | Scott Rogers <scott@scottandrewrogers.com> | 6223ce0 | Add Vite + MapLibre frontend
// END LICENSE HEADER
import { defineConfig } from "vite";

// In docker-compose the backend is reachable as http://backend:8000; locally it is on localhost.
const backend = process.env.BACKEND_URL ?? "http://localhost:8000";

export default defineConfig({
  build: {
    target: "es2022", // top-level await in main.ts
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": { target: backend, changeOrigin: true },
    },
  },
});
