import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// 获取当前脚本路径
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 确保日志目录存在
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// 日志文件路径
const outLog = path.join(logDir, 'out.log');
const errLog = path.join(logDir, 'err.log');

// 创建日志流
const out = fs.openSync(outLog, 'a');
const err = fs.openSync(errLog, 'a');

// 服务器脚本路径
const serverPath = path.join(__dirname, 'server.js');

// 系统CPU和内存数量
const cpus = os.cpus().length;
const memory = Math.floor(os.totalmem() / (1024 * 1024 * 1024)); // GB

console.log('===== 启动 WebTorrent 下载服务 =====');
console.log(`系统信息: ${cpus} CPU核心, ${memory}GB 内存`);
console.log(`服务脚本路径: ${serverPath}`);
console.log(`日志输出: ${outLog}`);
console.log(`错误日志: ${errLog}`);

// 环境变量设置
const env = { ...process.env };

// 根据系统资源优化配置
if (cpus >= 4) {
  env.MAX_CONNECTIONS = '200'; // 更多连接
} else {
  env.MAX_CONNECTIONS = '100'; // 适中连接数
}

if (memory >= 8) {
  env.MAX_DISK_SPACE = (5 * 1024 * 1024 * 1024).toString(); // 5GB
} else if (memory >= 4) {
  env.MAX_DISK_SPACE = (2 * 1024 * 1024 * 1024).toString(); // 2GB
} else {
  env.MAX_DISK_SPACE = (1 * 1024 * 1024 * 1024).toString(); // 1GB
}

// 运行模式
env.NODE_ENV = 'production';

try {
  // 启动服务器进程
  const server = spawn('node', [serverPath], {
    cwd: __dirname,
    detached: true,
    stdio: ['ignore', out, err],
    env: env
  });

  // 分离进程
  server.unref();

  console.log(`服务已启动，进程ID: ${server.pid}`);
  console.log('服务在后台运行中，您可以关闭此终端窗口...');
} catch (err) {
  console.error('启动服务失败:', err);
} 