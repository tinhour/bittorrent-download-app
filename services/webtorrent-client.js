import WebTorrent from 'webtorrent';
import path from 'path';
import logger from '../utils/logger.js';
import config from '../config/index.js';
import systemMonitor from '../utils/system-monitor.js';
import diskManager from './disk-manager.js';
import fs from 'fs';
import dhtEnhancer from './dht-enhancer.js';

// 下载路径
const downloadPath = config.DOWNLOAD_PATH;

// 确保下载目录存在
try {
  if (!fs.existsSync(downloadPath)) {
    logger.info(`创建下载目录: ${downloadPath}`);
    fs.mkdirSync(downloadPath, { recursive: true });
    logger.info('下载目录创建成功');
  } else {
    logger.info(`下载目录已存在: ${downloadPath}`);
    // 检查下载目录的内容
    const files = fs.readdirSync(downloadPath);
    logger.info(`下载目录中的文件和文件夹数量: ${files.length}`);
    if (files.length > 0) {
      logger.info(`下载目录内容: ${files.join(', ')}`);
    }
  }
} catch (err) {
  logger.error(`下载目录操作失败: ${err.message}`);
}

// 创建并配置WebTorrent客户端
const client = new WebTorrent({
  maxConns: config.MAX_CONNECTIONS,
  maxWebConns: config.MAX_WEB_CONNS,
  dht: config.DHT_ENABLED ? {
    bootstrap: [
      'router.bittorrent.com:6881',
      'dht.transmissionbt.com:6881',
      'router.utorrent.com:6881',
      'dht.libtorrent.org:25401',
      'dht.aelitis.com:6881'
    ]
  } : false,
  webSeeds: true,
  utp: config.UTP_ENABLED,
  tracker: config.TRACKERS_ENABLED,
  path: downloadPath
});

// 注册客户端事件处理
function setupClientEvents() {
  // 注册WebTorrent客户端到监控模块
  systemMonitor.registerClient(client);
  
  // 监听 WebTorrent 客户端事件
  client.on('error', (err) => {
    logger.error(`WebTorrent 错误: ${err.message}`);
  });
  
  client.on('torrent', (torrent) => {
    logger.info(`新种子已添加: ${torrent.infoHash}`);
    diskManager.registerTorrent(torrent.infoHash);
  });
}

// 启用PEX和LSD 
function enablePeerDiscovery(torrent) {
  // 确保torrent对象存在
  if (!torrent || !torrent.discovery) return;
  
  // 启用UTPEX扩展
  if (typeof torrent.discovery.pex === 'boolean') {
    torrent.discovery.pex = true;
    logger.info('启用PEX扩展');
  }
  
  // 启用本地服务发现(LSD)
  if (torrent.discovery.lsd === false) {
    torrent.discovery.lsd = true;
    logger.info('启用本地服务发现(LSD)');
  }
}

// 向已存在的种子添加更多tracker
function addMoreTrackersToTorrent(torrent, trackers) {
  if (!torrent) return 0;
  
  logger.info(`向种子 ${torrent.infoHash || ''} 添加更多tracker，当前连接节点: ${torrent.numPeers || 0}`);
  
  try {
    // 获取所有可用tracker
    let added = 0;
    
    // 检查torrent是否有addTrackers方法
    if (typeof torrent.addTrackers === 'function') {
      // 获取当前已有的tracker
      const currentTrackers = new Set();
      
      // 如果有announce属性，提取现有tracker
      if (Array.isArray(torrent.announce)) {
        torrent.announce.forEach(tracker => currentTrackers.add(tracker.toString()));
      }
      
      // 过滤出新的tracker
      const newTrackers = trackers.filter(tracker => !currentTrackers.has(tracker));
      
      if (newTrackers.length > 0) {
        logger.info(`添加 ${newTrackers.length} 个新tracker`);
        torrent.addTrackers(newTrackers);
        added = newTrackers.length;
      } else {
        logger.info('没有新的tracker可添加');
      }
    } else {
      logger.warn('种子对象不支持addTrackers方法');
    }
    
    // 确保启用DHT和PEX
    enablePeerDiscovery(torrent);
    
    logger.info(`成功添加 ${added} 个新tracker到种子`);
    return added;
  } catch (err) {
    logger.error(`添加tracker失败: ${err.message}`);
    return 0;
  }
}

// 设置种子事件监听
function setupTorrentEvents(torrent, torrentInfo, addMoreTrackersCallback) {
  // 监听下载进度
  let lastProgress = 0;
  
  // 添加事件监听 - 定期报告状态
  const statusInterval = setInterval(() => {
    if (torrent.destroyed) {
      clearInterval(statusInterval);
      return;
    }
    
    const progress = Math.round(torrent.progress * 100);
    logger.info(`[${torrent.name || torrent.infoHash}] 状态报告:`);
    logger.info(`- 进度: ${progress}%`);
    logger.info(`- 下载速度: ${(torrent.downloadSpeed / 1024 / 1024).toFixed(2)} MB/s`);
    logger.info(`- 已下载: ${(torrent.downloaded / 1024 / 1024).toFixed(2)} MB`);
    logger.info(`- 连接节点: ${torrent.numPeers}`);
    logger.info(`- 文件数量: ${torrent.files ? torrent.files.length : 0}`);
    
    // 如果检测到没有任何进展，尝试添加更多tracker
    if (progress === lastProgress && progress < 100 && torrent.numPeers < 5) {
      logger.info('检测到下载进度停滞，尝试添加更多tracker和节点');
      if (typeof addMoreTrackersCallback === 'function') {
        addMoreTrackersCallback(torrent);
      }
    }
    
    lastProgress = progress;
  }, 30000); // 每30秒报告一次
  
  torrent.on('download', (bytes) => {
    // 由于此事件会频繁触发，这里只记录日志不做其他处理
    // 避免日志过多，只在每下载2MB时记录一次
    if (bytes > 2 * 1024 * 1024) {
      const progress = Math.round(torrent.progress * 100);
      if (progress !== lastProgress) {
        logger.info(`[${torrent.name || torrent.infoHash}] 下载进度: ${progress}% (速度: ${(torrent.downloadSpeed / 1024 / 1024).toFixed(2)} MB/s)`);
        lastProgress = progress;
      }
    }
  });
  
  torrent.on('wire', (wire, addr) => {
    logger.info(`[${torrent.name || torrent.infoHash}] 连接到新节点: ${addr} (现有节点: ${torrent.wires.length})`);
    
    // 监听节点断开连接
    wire.once('close', () => {
      logger.info(`[${torrent.name || torrent.infoHash}] 节点断开连接: ${addr}`);
    });
  });
  
  torrent.on('done', () => {
    logger.info(`种子 ${torrent.name || torrent.infoHash} 下载完成`);
    if (torrentInfo) {
      torrentInfo.status = 'completed';
    }
    
    // 检查下载的文件
    try {
      logger.info(`检查种子 ${torrent.infoHash} 的下载文件`);
      
      // 种子目录
      const torrentDir = path.join(downloadPath, torrent.infoHash);
      if (fs.existsSync(torrentDir)) {
        logger.info(`种子目录存在: ${torrentDir}`);
        
        // 检查目录内容
        const files = fs.readdirSync(torrentDir);
        logger.info(`种子目录包含 ${files.length} 个文件`);
        
        if (files.length > 0) {
          logger.info('下载的文件:');
          files.forEach(file => {
            const filePath = path.join(torrentDir, file);
            const stats = fs.statSync(filePath);
            logger.info(`- ${file} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
          });
          
          logger.info('文件已成功保存到:');
          logger.info(`- 种子目录: ${torrentDir}`);
          logger.info(`- 绝对路径: ${path.resolve(torrentDir)}`);
        } else {
          logger.warn('种子目录存在但为空!');
        }
      } else {
        logger.info(`种子infoHash目录不存在: ${torrentDir}`);
        
        // 检查种子名称目录
        const torrentNameDir = path.join(downloadPath, torrent.name);
        if (fs.existsSync(torrentNameDir)) {
          logger.info(`找到种子名称目录: ${torrentNameDir}`);
          const files = fs.readdirSync(torrentNameDir);
          logger.info(`种子名称目录包含 ${files.length} 个文件`);
          if (files.length > 0) {
            logger.info('下载的文件:');
            files.forEach(file => {
              const filePath = path.join(torrentNameDir, file);
              const stats = fs.statSync(filePath);
              logger.info(`- ${file} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
            });
            
            logger.info('文件已成功保存到:');
            logger.info(`- 种子名称目录: ${torrentNameDir}`);
            logger.info(`- 绝对路径: ${path.resolve(torrentNameDir)}`);
          } else {
            logger.warn('种子名称目录存在但为空!');
          }
        } else {
          logger.error(`种子名称目录不存在: ${torrentNameDir}`);
          
          // 检查WebTorrent自己创建的目录
          const originalDir = path.join(downloadPath, torrent.originalName || torrent.name);
          if (fs.existsSync(originalDir)) {
            logger.info(`找到可能的替代目录: ${originalDir}`);
            const files = fs.readdirSync(originalDir);
            logger.info(`替代目录包含 ${files.length} 个文件`);
            if (files.length > 0) {
              files.forEach(file => {
                const filePath = path.join(originalDir, file);
                const stats = fs.statSync(filePath);
                logger.info(`- ${file} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
              });
            }
          } else {
            // 搜索整个下载根目录
            logger.info(`搜索下载根目录: ${downloadPath}`);
            if (fs.existsSync(downloadPath)) {
              const rootFiles = fs.readdirSync(downloadPath);
              logger.info(`下载根目录包含 ${rootFiles.length} 个项目`);
              rootFiles.forEach(item => {
                const itemPath = path.join(downloadPath, item);
                try {
                  const stats = fs.statSync(itemPath);
                  if (stats.isDirectory()) {
                    logger.info(`- 目录: ${item}`);
                  } else {
                    logger.info(`- 文件: ${item} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
                  }
                } catch (e) {
                  logger.warn(`无法获取项目信息: ${item}`);
                }
              });
            } else {
              logger.error(`下载根目录不存在: ${downloadPath}`);
            }
          }
        }
      }
    } catch (err) {
      logger.error(`检查下载文件时出错: ${err.message}`);
    }
    
    clearInterval(statusInterval);
  });
  
  torrent.on('error', (err) => {
    logger.error(`种子 ${torrent.name || torrent.infoHash} 下载错误:`, err);
    if (torrentInfo) {
      torrentInfo.status = 'error';
      torrentInfo.error = err.message;
    }
    clearInterval(statusInterval);
  });
  
  torrent.on('warning', (err) => {
    logger.warn(`种子 ${torrent.name || torrent.infoHash} 警告:`, err);
  });
  
  torrent.on('noPeers', () => {
    logger.warn(`种子 ${torrent.name || torrent.infoHash} 没有找到可连接的节点`);
    
    // 尝试添加更多tracker
    logger.info('尝试添加更多tracker以寻找节点');
    if (typeof addMoreTrackersCallback === 'function') {
      addMoreTrackersCallback(torrent);
    }
  });
  
  // 如果种子被销毁，清理定时器
  torrent.once('close', () => {
    logger.info(`种子 ${torrent.name || torrent.infoHash} 被关闭`);
    clearInterval(statusInterval);
  });
}

// 计算文件级别的进度
function calculateFileProgress(torrent, file) {
  if (!torrent || !file) return 0;
  
  try {
    // 如果文件已完成
    if (file.done) return 1;
    
    // 尝试获取文件的下载块信息
    if (typeof file.progress === 'number') {
      return file.progress;
    }
    
    // 回退到种子级别的进度
    return torrent.progress || 0;
  } catch (err) {
    logger.warn(`计算文件进度出错: ${err.message}`);
    return torrent.progress || 0;
  }
}

// 初始化
setupClientEvents();

export default {
  client,
  downloadPath,
  enablePeerDiscovery,
  addMoreTrackersToTorrent,
  setupTorrentEvents,
  calculateFileProgress
}; 