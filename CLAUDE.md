# Workflow

- This is a solo, low-stakes project. Commit directly to `main` and push. Do not create branches or pull requests, and do not ask for confirmation before pushing.
- Every push to `main` deploys to production (2ndorder.live) via `.github/workflows/deploy.yml`, which runs `scripts/deploy.sh`.
- Run `npm run check:tools` and `npm run build` before pushing so a broken build does not reach production.
