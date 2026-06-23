const { execSync } = require('child_process');
const port = process.env.PORT || 3050;

try {
  if (process.platform === 'win32') {
    const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    const pids = [...new Set(
      out.trim().split('\n')
        .map(line => line.trim().split(/\s+/).pop())
        .filter(pid => /^\d+$/.test(pid) && pid !== '0')
    )];
    if (pids.length) {
      pids.forEach(pid => {
        try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch (_) {}
      });
      console.log(`Port ${port} libéré (PID ${pids.join(', ')})`);
    }
  } else {
    execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore' });
  }
} catch (_) {}
