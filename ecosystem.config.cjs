// pm2 process definition for the PRism hub.
// Usage: pnpm pm2:start   (build first if apps/cli/dist doesn't exist yet: pnpm build)
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "prsm",
      script: path.join(__dirname, "apps", "cli", "dist", "index.js"),
      args: ["--serve-ui"],
      cwd: __dirname,
      interpreter: "node",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
