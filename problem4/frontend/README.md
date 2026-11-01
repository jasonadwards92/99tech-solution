# Frontend

The SPA source is out of scope for this challenge. This folder only shows where it lives. The workflows (`ci-frontend.yml` and `cd-frontend.yml`) expect the app to meet this contract:

- `package.json` defines the `pnpm` scripts `lint`, `test` and `build`.
- `pnpm-lock.yaml` is committed, because CI installs with `pnpm install --frozen-lockfile`.
- `pnpm run build` writes the site to `dist/`, with content-hashed JS and CSS files under `dist/assets/` and `index.html` at the top of `dist/`.
- The app reads its API URL from `/config.json` at startup instead of from a build-time variable. Each deploy job writes that file per environment as `{"apiUrl": "...", "version": "<commit-sha>"}`.
