const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function inspectFile(name, content = '') {
  const issues = [];
  const parts = name.replace(/\\/g, '/').split('/');
  const base = parts.at(-1);
  if ((base.startsWith('.env') && base !== '.env.example')
      || /\.(?:sqlite(?:-wal|-shm)?|db|log|bak|pem|key|docx)$/i.test(base)
      || parts.some((part) => ['.claude', '.codex', '.aws', 'node_modules', '.venv', 'backups'].includes(part))
      || /^(?:data|uploads)\//.test(name) && base !== '.gitkeep') {
    issues.push('private-file');
  }
  const patterns = {
    'private-key': /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    'github-token': /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
    'google-api-key': /\bAIza[A-Za-z0-9_-]{30,}\b/,
    'api-token': /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{24,}|hf_[A-Za-z0-9]{25,}|AKIA[A-Z0-9]{16})\b/,
    'personal-tunnel': /https?:\/\/[a-z0-9-]+\.(?:ngrok-free\.(?:app|dev)|ngrok\.app)\b/i,
    'line-identity': /\b[UCR][0-9a-f]{32}\b/i,
    'credential-url': /https?:\/\/[^\s/@:]+:[^\s/@]+@/,
  };
  for (const [label, regex] of Object.entries(patterns)) {
    if (regex.test(content)) issues.push(label);
  }
  return issues;
}

function check(root = path.resolve(__dirname, '..')) {
  const names = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  if (!names.length) throw new Error('No tracked files to inspect; stage the public snapshot first.');
  const findings = [];
  for (const name of names) {
    const bytes = fs.readFileSync(path.join(root, name));
    const content = /\.(?:png|jpe?g|pdf)$/i.test(name) ? '' : bytes.toString('utf8');
    for (const issue of inspectFile(name, content)) findings.push(`${name}: ${issue}`);
  }
  if (findings.length) throw new Error(findings.join('\n'));
  console.log(`Public release check passed: ${names.length} tracked files.`);
}

if (require.main === module) {
  try { check(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { inspectFile, check };
