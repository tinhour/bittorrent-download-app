import { createLogger, format, transports } from 'winston';
import path from 'path';
import fs from 'fs';
import config from '../config/index.js';
import { fileURLToPath } from 'url';

// 创建日志目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const logDir = config.LOG_PATH || path.join(__dirname, 'logs');

// 确保日志目录存在
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// 自定义日志格式
const customFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  format.errors({ stack: true }),
  format.splat(),
  format.printf(({ level, message, timestamp, stack }) => {
    return `${timestamp} ${level.toUpperCase()}: ${message} ${stack ? '\n' + stack : ''}`;
  })
);

// 创建日志输出方式
const consoleTransport = new transports.Console({
  format: format.combine(
    format.colorize(),
    customFormat
  ),
  level: config.DEBUG ? 'debug' : 'info'
});

// 文件输出 - 按日期分割
const fileTransport = new transports.File({
  filename: path.join(logDir, 'app.log'),
  maxsize: 5242880, // 5MB
  maxFiles: 5,
  format: customFormat,
  level: config.LOG_LEVEL || 'info'
});

// 错误日志单独保存
const errorFileTransport = new transports.File({
  filename: path.join(logDir, 'error.log'),
  level: 'error',
  format: customFormat
});

// 创建日志实例
const logger = createLogger({
  level: config.LOG_LEVEL || 'info',
  format: customFormat,
  transports: [
    consoleTransport,
    fileTransport,
    errorFileTransport
  ],
  exitOnError: false
});

// 添加未捕获异常处理
logger.exceptions.handle(
  new transports.File({ 
    filename: path.join(logDir, 'exceptions.log'),
    format: customFormat
  })
);

// 额外添加debug日志配置
if (config.DEBUG) {
  logger.info('调试模式已启用，日志级别设置为debug');
}

export default logger; 