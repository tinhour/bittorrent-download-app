import express from 'express';
import http from 'http';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';

// 导入自定义模块
import config from './config/index.js';
import logger from './utils/logger.js';
import systemMonitor from './utils/system-monitor.js';
import dbService from './services/db-service.js';
import dhtEnhancer from './services/dht-enhancer.js';
import torrentService from './services/torrent-service.js';
import webtorrentClient from './services/webtorrent-client.js';
import trackerUtils from './utils/tracker-utils.js';

// 导入路由
import apiRoutes from './routes/api-routes.js';
import streamRoutes from './routes/stream-routes.js';

// 添加全局错误处理，防止程序崩溃
process.on('uncaughtException', (err) => {
  logger.error(`未捕获的异常: ${err.message}\n${err.stack}`);
  // 记录错误但不退出进程
});

process.on('unhandledRejection', (reason) => {
  logger.error(`未处理的Promise拒绝: ${reason instanceof Error ? reason.message : reason}`);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

logger.info('初始化应用...');
const app = express();

// 添加中间件
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// 添加请求计数中间件
app.use((req, res, next) => {
  systemMonitor.updateConnections(webtorrentClient.client ? webtorrentClient.client.torrents.length : 0);
  next();
});

// 添加路由
app.use('/api', apiRoutes);
app.use('/', streamRoutes);

// 健康检查端点
app.get('/health', (req, res) => {
  const health = systemMonitor.getHealthMetrics();
  const status = health.status === 'healthy' ? 200 : 
                (health.status === 'warning' ? 429 : 503);
  
  res.status(status).json(health);
});

// 添加错误处理中间件
app.use((err, req, res, next) => {
  logger.error(`Express错误: ${err.message}`);
  systemMonitor.logError(err);
  systemMonitor.incrementFailedRequests();
  res.status(500).json({ error: '服务器内部错误' });
});

// 创建并启动服务器
const server = http.createServer(app);
const PORT = config.PORT;
const HOST = config.HOST;

server.listen(PORT, HOST, async () => {
  logger.info(`服务器运行在 http://${HOST}:${PORT}`);
  logger.info(`健康检查: http://${HOST}:${PORT}/health`);
  logger.info(`状态页面: http://${HOST}:${PORT}/api/status`);

// 如果启用了DHT增强器，启动它
  if (config.DHT_ENABLED && dhtEnhancer) {
  dhtEnhancer.connect();
}

  // 启动时获取最新tracker列表
  try {
    const trackers = await trackerUtils.updateTrackersList();
    logger.info(`已获取 ${trackers.length} 个tracker`);
    
    // 从数据库恢复下载
    await torrentService.restoreDownloadsFromDatabase();
      } catch (err) {
    logger.error(`获取tracker列表失败: ${err.message}`);
    
    // 即使获取tracker列表失败，也尝试恢复下载
    await torrentService.restoreDownloadsFromDatabase();
  }
  
  // 启动定期任务
  setupPeriodicTasks();
});

// 设置定期任务
function setupPeriodicTasks() {
  // 每6小时刷新一次tracker列表
  setInterval(async () => {
    logger.info('定期刷新tracker列表...');
    try {
      const trackers = await trackerUtils.updateTrackersList();
      logger.info(`成功获取 ${trackers.length} 个tracker`);
      
      // 更新已存在的种子
      const activeTorrents = webtorrentClient.client.torrents;
      if (activeTorrents.length > 0) {
        logger.info(`更新 ${activeTorrents.length} 个活动种子的tracker`);
        
        activeTorrents.forEach(torrent => {
          try {
            const added = webtorrentClient.addMoreTrackersToTorrent(torrent, trackers);
            logger.info(`为种子 ${torrent.name || torrent.infoHash} 添加了 ${added} 个新tracker`);
    } catch (err) {
            logger.warn(`为种子 ${torrent.name || torrent.infoHash} 添加tracker失败:`, err.message);
    }
  });
}
  } catch (err) {
      logger.error('刷新tracker列表失败:', err.message);
    }
  }, 6 * 60 * 60 * 1000);
  
  // 更新种子总体进度 - 每5秒更新一次
  setInterval(async () => {
    try {
      // 获取所有活动种子
      const torrents = webtorrentClient.client.torrents;
      
      for (const torrent of torrents) {
        // 确保种子存在且有infoHash
        if (torrent && torrent.infoHash) {
          const progressData = {
            progress: torrent.progress,
            downloadSpeed: torrent.downloadSpeed,
            uploadSpeed: torrent.uploadSpeed,
            downloaded: torrent.downloaded,
            uploaded: torrent.uploaded,
            numPeers: torrent.numPeers,
            numSeeds: torrent.numSeeds,
            // 将timeRemaining转换为BigInt或null
            timeRemaining: typeof torrent.timeRemaining === 'number' 
              ? (isFinite(torrent.timeRemaining) ? BigInt(Math.floor(torrent.timeRemaining)) : null) 
              : null
          };
          
          // 如果种子已完成，设置完成时间
          if (torrent.progress === 1 && !torrent.done) {
            progressData.dateCompleted = new Date();
            torrent.done = true;
          }
          
          try {
            // 先检查种子记录是否存在
            const existingRecord = await dbService.getTorrentByInfoHash(torrent.infoHash);
            
            if (existingRecord) {
              // 种子记录存在，正常更新进度
              await dbService.updateTorrentProgress(torrent.infoHash, progressData);
  } else {
              // 种子记录不存在，需要先创建记录
              logger.info(`数据库中不存在种子记录 ${torrent.infoHash}，创建新记录`);
              
              // 创建基本种子记录
  const torrentData = {
    infoHash: torrent.infoHash,
                name: torrent.name || '未知种子',
                magnetURI: torrent.magnetURI || `magnet:?xt=urn:btih:${torrent.infoHash}`,
    size: torrent.length || 0,
                dateAdded: new Date(),
                ...progressData
              };
              
              // 创建记录
              await dbService.createOrUpdateTorrent(torrentData);
              
              // 如果种子有文件信息，也添加文件记录
      if (torrent.files && torrent.files.length > 0) {
                const fileRecords = torrent.files.map((file, index) => ({
          path: file.path,
          name: file.name,
                  size: BigInt(file.length),
                  progress: file.progress || 0,
                  isSelected: true,
                  index: index // 保存文件索引，用于后续更新
                }));
                
                // 获取新创建的记录以获取ID
                const newRecord = await dbService.getTorrentByInfoHash(torrent.infoHash);
                if (newRecord) {
                  await dbService.addTorrentFiles(newRecord.id, fileRecords);
                }
              }
            }
          } catch (torrentError) {
            logger.error(`处理种子进度时出错: ${torrentError.message}`);
          }
        }
      }
        } catch (error) {
      logger.error(`更新种子进度出错: ${error.message}`);
    }
  }, 5000);
  
  // 更新单个文件进度 - 每10秒更新一次
  setInterval(async () => {
    try {
      // 获取所有活动种子
      const activeTorrents = webtorrentClient.client.torrents;
      
      // 遍历每个种子，更新文件进度
    for (const torrent of activeTorrents) {
        if (!torrent || !torrent.files || torrent.files.length === 0) continue;
        
        // 获取种子数据库记录
        try {
          const dbTorrent = await dbService.getTorrentByInfoHash(torrent.infoHash);
          if (!dbTorrent) continue;
          
          // 更新每个文件的进度
          for (let i = 0; i < torrent.files.length; i++) {
            const file = torrent.files[i];
            
            // 计算文件级别的进度
            let fileProgress = 0;
            try {
              if (typeof file.progress === 'function') {
                fileProgress = file.progress();
              } else if (typeof file.progress === 'number') {
                fileProgress = file.progress;
              } else {
                fileProgress = webtorrentClient.calculateFileProgress(torrent, file);
              }
      } catch (err) {
              fileProgress = torrent.progress || 0;
            }
            
            // 确保进度在合理范围内
            fileProgress = Math.max(0, Math.min(1, fileProgress));
            
            // 更新数据库中的文件进度
            await dbService.updateFileProgress(dbTorrent.id, i, fileProgress);
          }
          } catch (err) {
          logger.warn(`更新文件进度失败: ${err.message}`);
              }
            }
          } catch (err) {
      logger.error(`文件进度更新任务失败: ${err.message}`);
    }
  }, 10000);
  
  // 设置清理任务 - 每天执行一次
  setupCleanupTask();
}

// 设置清理任务
function setupCleanupTask() {
// 每天午夜执行清理已删除记录的任务
const cleanupInterval = 24 * 60 * 60 * 1000; // 24小时
const runCleanupTask = async () => {
  try {
    logger.info('开始执行清理已删除记录任务...');
    const deletedCount = await dbService.cleanupDeletedRecords(30); // 清理30天前的已删除记录
    logger.info(`清理任务完成: 已删除 ${deletedCount} 条记录`);
  } catch (error) {
    logger.error(`清理已删除记录任务出错: ${error.message}`);
  }
};

// 计算到今天午夜的时间
const calculateTimeToMidnight = () => {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight.getTime() - now.getTime();
};

// 安排第一次执行时间
let initialDelay = calculateTimeToMidnight();
logger.info(`清理任务将在 ${Math.round(initialDelay / (60 * 60 * 1000))} 小时后首次执行`);

// 设置清理任务
setTimeout(() => {
  runCleanupTask(); // 首次执行
  setInterval(runCleanupTask, cleanupInterval); // 之后每24小时执行一次
}, initialDelay);
}

export default server;
