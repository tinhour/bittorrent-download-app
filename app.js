import server from './server.js';
import logger from './utils/logger.js';
import config from './config/index.js';

// 启动消息
logger.info('----------------------------------------');
logger.info('BitTorrent 下载应用服务器');
logger.info(`版本: 1.0.0`);
logger.info(`运行环境: ${process.env.NODE_ENV || 'development'}`);
logger.info(`服务器端口: ${config.PORT}`);
logger.info(`下载目录: ${config.DOWNLOAD_PATH}`);
logger.info('----------------------------------------');

// 全局未捕获异常处理
process.on('uncaughtException', (err) => {
  logger.error(`未捕获的异常: ${err.message}\n${err.stack}`);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的Promise拒绝', reason);
});

// 处理进程信号
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// 优雅关闭函数
function gracefulShutdown() {
  logger.info('接收到关闭信号，正在优雅关闭...');
  
  // 关闭服务器
  server.close(() => {
    logger.info('HTTP服务器已关闭');
    logger.info('应用已完全关闭，退出进程');
    process.exit(0);
  });
  
  // 如果10秒后还没关闭完成，强制退出
  setTimeout(() => {
    logger.error('无法在规定时间内优雅关闭，强制退出');
    process.exit(1);
  }, 10000);
}

// 导出服务器实例
export default server; 