import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../');

// 确定下载目录
const DEFAULT_DOWNLOAD_PATH = process.platform === 'win32' 
  ? path.join(os.homedir(), 'Downloads', 'webtorrent-downloads')
  : path.join('/tmp', 'webtorrent-downloads');

// 基本配置
const config = {
  // 服务器配置
  PORT: process.env.PORT || 3000,
  HOST: process.env.HOST || '0.0.0.0',
  
  // 路径配置
  PROJECT_ROOT,
  DOWNLOAD_PATH: process.env.DOWNLOAD_PATH || DEFAULT_DOWNLOAD_PATH,
  LOG_PATH: process.env.LOG_PATH || path.join(PROJECT_ROOT, 'logs'),
  
  // 数据库配置
  DB_URL: process.env.DATABASE_URL || 'file:./dev.db',
  
  // WebTorrent配置
  MAX_CONNECTIONS: parseInt(process.env.MAX_CONNECTIONS || '100'),
  MAX_WEB_CONNS: parseInt(process.env.MAX_WEB_CONNS || '20'),
  DHT_ENABLED: process.env.DHT_ENABLED !== 'false',
  UTP_ENABLED: process.env.UTP_ENABLED !== 'false',
  TRACKERS_ENABLED: process.env.TRACKERS_ENABLED !== 'false',
  
  // 磁盘管理
  DISK_SPACE_LIMIT: parseInt(process.env.DISK_SPACE_LIMIT || '10737418240'), // 默认10GB
  CLEANUP_INTERVAL: parseInt(process.env.CLEANUP_INTERVAL || '21600000'), // 默认6小时
  
  // 调试与日志
  DEBUG: process.env.DEBUG === 'true',
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  
  // API限制
  MAX_TORRENTS: parseInt(process.env.MAX_TORRENTS || '100'),
  RATE_LIMIT: parseInt(process.env.RATE_LIMIT || '100'),
};

export default config; 