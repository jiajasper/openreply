// PM2 process definitions for the full-Mac deployment: the web app, the DM
// worker (which also drives token refresh and follower snapshots), and the
// Cloudflare Tunnel that gives Meta a public URL to reach.
//
// Start everything with `pm2 start ecosystem.config.js && pm2 save`.

const CWD = "/Users/jasperm2/Documents/openreply";

const common = {
  cwd: CWD,
  autorestart: true,
  max_restarts: 10,
  min_uptime: "10s",
  // Without this a restart loop against a broken build/database would spin
  // forever; ten attempts with a 10s floor is enough to ride out a slow boot.
  exp_backoff_restart_delay: 1000,
};

module.exports = {
  apps: [
    {
      name: "openreply-web",
      // `next start` against the committed production build, not `next dev`:
      // the dev server recompiles on request and its extra memory is wasted on
      // a machine that is also running Postgres, Redis and the worker.
      script: "npm",
      args: "start",
      ...common,
      env: { NODE_ENV: "production" },
      log_file: "./logs/combined.log",
      error_file: "./logs/web-error.log",
      out_file: "./logs/web-out.log",
      merge_logs: true,
    },
    {
      name: "openreply-worker",
      // Carries the token-refresh and follower-snapshot timers, replacing the
      // Vercel crons in vercel.json, which do not run here. Reads .env via
      // `tsx --env-file` in the npm script.
      script: "npm",
      args: "run worker",
      ...common,
      env: { NODE_ENV: "production" },
      log_file: "./logs/combined.log",
      error_file: "./logs/worker-error.log",
      out_file: "./logs/worker-out.log",
      merge_logs: true,
    },
    {
      name: "cloudflared",
      // Reads ~/.cloudflared/config.yml, which maps the tunnel hostname to
      // http://localhost:3000.
      script: "cloudflared",
      args: "tunnel run openreply",
      ...common,
      log_file: "./logs/tunnel.log",
      merge_logs: true,
    },
  ],
};
