// pm2 process file. Two instances in cluster mode, so `pm2 reload` restarts
// them one at a time and the site never goes down during an update.
//
// Settings live in /etc/strategy-lab/env, not
// in this file. It's read again on every `pm2 reload ... --update-env`.
const fs = require('fs');

const ENV_FILE = process.env.STRATEGY_LAB_ENV || '/etc/strategy-lab/env';
const env = { NODE_ENV: 'production' };
for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}

module.exports = {
  apps: [{
    name: 'strategy-lab',
    script: 'server/index.js',
    cwd: __dirname + '/..',
    instances: 2,
    exec_mode: 'cluster',
    env,
    max_memory_restart: '600M',
    time: true,
  }],
};
