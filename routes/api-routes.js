import express from 'express';
import logger from '../utils/logger.js';
import systemMonitor from '../utils/system-monitor.js';
import dbService from '../services/db-service.js';
import diskManager from '../services/disk-manager.js';
import dhtEnhancer from '../services/dht-enhancer.js';
import webtorrentClient from '../services/webtorrent-client.js';
import torrentService from '../services/torrent-service.js';
import trackerUtils from '../utils/tracker-utils.js';

const router = express.Router();
const client = webtorrentClient.client;

// API: 添加新的磁力链接
router.post('/add', async (req, res) => {
  try {
    const { magnetURI } = req.body;
    
    if (!magnetURI) {
      return res.status(400).json({ success: false, error: '缺少磁力链接' });
    }
    
    if (!magnetURI.startsWith('magnet:?')) {
      return res.status(400).json({ success: false, error: '磁力链接格式不正确' });
    }
    
    logger.info(`收到新的磁力链接: ${magnetURI}`);
    
    // 检查磁力链接健康性
    let infoHash = '';
    try {
      if (magnetURI.includes('magnet:?xt=urn:btih:')) {
        const infoHashPart = magnetURI.split('magnet:?xt=urn:btih:')[1].split('&')[0];
        infoHash = trackerUtils.normalizeInfoHash(infoHashPart);
        logger.info(`解析得到InfoHash: ${infoHash}`);
        
        // 尝试主动查找种子信息
        try {
          logger.info('主动查找种子信息...');
          await searchMagnetInfo(infoHash);
        } catch (searchErr) {
          logger.warn('查找种子信息失败:', searchErr.message);
        }
      }
    } catch (parseErr) {
      logger.error(`解析磁力链接失败: ${parseErr.message}`);
    }
    
    // 获取改进的磁力链接
    const enhancedMagnet = trackerUtils.getEnhancedMagnetURI(magnetURI);
    logger.info(`使用增强的磁力链接: ${enhancedMagnet}`);
    
    // 开始下载
    torrentService.addTorrent(enhancedMagnet).then(info => {
      // 通知DHT增强器
      if (infoHash && dhtEnhancer) {
        dhtEnhancer.announceInfoHash(infoHash);
      }
      logger.info(`添加种子并解析成功:${info.infoHash} : ${info.name}`);
      return res.json({
        success: true,
        message: '添加成功',
        infoHash: info.infoHash,
        name: info.name,
        files: info.files
      });
    }).catch(err => {
      logger.error(`添加种子失败: ${err.message}`);
      return res.status(500).json({
        success: false,
        error: `添加种子失败: ${err.message}`
      });
    });
  } catch (err) {
    logger.error(`处理添加请求时出错: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: `服务器错误: ${err.message}`
    });
  }
});

// 主动查找种子信息 - 尝试从BT索引网站查询
async function searchMagnetInfo(infoHash) {
  logger.info(`尝试查找infoHash: ${infoHash}的更多信息`);
  
  // 这里应该实现查询种子信息的逻辑
  // 例如调用BT索引网站API或爬虫
  
  try {
    // 示例: 尝试使用一些公共的BT搜索API
    // const response = await fetch(`https://example-bt-api.com/api/info?hash=${infoHash}`);
    // const data = await response.json();
    // 处理返回的数据...
    
    // 由于没有实际API，我们这里只是模拟
    logger.info('正在搜索BT索引...');
    
    // 如果找到信息，可以更新种子信息
    return {
      found: false,
      message: '暂未实现BT索引搜索功能'
    };
  } catch (err) {
    logger.error(`搜索种子信息失败: ${err.message}`);
    throw err;
  }
}

// API: 检查磁力链接健康状态
router.post('/check', async (req, res) => {
  try {
    const { magnetURI } = req.body;
    
    if (!magnetURI || !magnetURI.startsWith('magnet:?')) {
      return res.status(400).json({ success: false, error: '无效的磁力链接' });
    }
    
    // 输出WebTorrent版本信息
    logger.info('WebTorrent 版本:', client.VERSION || '未知');
    
    let infoHash = '';
    try {
      if (magnetURI.includes('magnet:?xt=urn:btih:')) {
        infoHash = magnetURI.split('magnet:?xt=urn:btih:')[1].split('&')[0].toLowerCase();
      }
    } catch (err) {}
    
    // 检查当前状态
    const result = {
      success: true,
      magnetURI,
      infoHash,
      clientStatus: {
        downloadSpeed: client.downloadSpeed,
        uploadSpeed: client.uploadSpeed,
        torrents: client.torrents.length,
        progress: client.progress
      },
      networkInfo: {
        trackers: trackerUtils.getDefaultTrackers(),
        connectionInfo: getNetworkDiagnostics()
      }
    };
    
    res.json(result);
  } catch (err) {
    logger.error('检查磁力链接失败:', err);
    res.status(500).json({ success: false, error: '检查失败', message: err.message });
  }
});

// 获取网络诊断信息
function getNetworkDiagnostics() {
  const info = {
    torrents: client.torrents.map(t => ({
      infoHash: t.infoHash,
      name: t.name,
      numPeers: t.numPeers,
      ready: t.ready,
      received: t.received,
      downloadSpeed: t.downloadSpeed,
      uploadSpeed: t.uploadSpeed
    }))
  };
  
  return info;
}

// API: 获取客户端健康状态
router.get('/health', (req, res) => {
  try {
    const healthInfo = {
      success: true,
      version: client.VERSION || 'unknown',
      client: {
        isRunning: true,
        downloadSpeed: client.downloadSpeed || 0,
        uploadSpeed: client.uploadSpeed || 0,
        ratio: client.ratio || 0,
        progress: client.progress || 0,
        torrentCount: client.torrents.length || 0
      },
      system: {
        platform: process.platform || 'unknown',
        nodeVersion: process.version || 'unknown',
        uptime: process.uptime() || 0,
        memory: process.memoryUsage() || {}
      },
      torrents: client.torrents.map(t => ({
        infoHash: t.infoHash || '',
        name: t.name || t.infoHash || 'unknown',
        numPeers: t.numPeers || 0,
        progress: t.progress || 0,
        timeRemaining: typeof t.timeRemaining === 'number' 
          ? (isFinite(t.timeRemaining) ? BigInt(Math.floor(t.timeRemaining)) : null) 
          : null,
        downloaded: t.downloaded || 0,
        downloadSpeed: t.downloadSpeed || 0
      }))
    };
    
    res.json(torrentService.serializeBigInt(healthInfo));
  } catch (err) {
    logger.error('获取健康状态失败:', err);
    res.status(500).json({ 
      success: false, 
      error: '获取健康状态失败',
      message: err.message 
    });
  }
});

// API: 获取所有种子列表
router.get('/list', async (req, res) => {
  try {
    // 从数据库获取所有种子记录
    const dbTorrents = await dbService.getAllTorrents();
    
    // 获取当前活动的种子列表
    const activeTorrents = [];
    
    if (client && client.torrents) {
      // 遍历当前活动的种子，收集实时信息
      for (const torrent of client.torrents) {
        try {
          if (!torrent || torrent.destroyed) continue;
          
          const torrentInfo = {
            infoHash: torrent.infoHash,
            name: torrent.name,
            magnetURI: torrent.magnetURI,
            progress: torrent.progress,
            downloaded: torrent.downloaded,
            uploaded: torrent.uploaded,
            downloadSpeed: torrent.downloadSpeed,
            uploadSpeed: torrent.uploadSpeed,
            ratio: torrent.ratio,
            numPeers: torrent.numPeers,
            size: torrent.length,
            timeRemaining: typeof torrent.timeRemaining === 'number' 
              ? (isFinite(torrent.timeRemaining) ? BigInt(Math.floor(torrent.timeRemaining)) : null) 
              : null,
            isPaused: torrent.paused, // 确保使用isPaused字段
            done: torrent.done,
            ready: torrent.ready
          };
          
          activeTorrents.push(torrentInfo);
        } catch (error) {
          logger.error(`获取种子信息错误: ${error.message}`);
        }
      }
    }
    
    // 将数据库记录与活动种子信息合并
    // 对于活动中的种子，优先使用活动信息
    const activeInfoHashes = new Set(activeTorrents.map(t => t.infoHash));
    
    const mergedTorrents = [
      ...activeTorrents,
      // 添加数据库中有但活动列表中没有的种子
      ...dbTorrents
        .filter(t => !activeInfoHashes.has(t.infoHash))
        .map(t => ({
          infoHash: t.infoHash,
          name: t.name,
          magnetURI: t.magnetURI,
          progress: t.progress,
          downloaded: Number(t.downloaded) || 0, // 转换BigInt为Number
          uploaded: Number(t.uploaded) || 0,     // 转换BigInt为Number
          downloadSpeed: 0, // 非活动种子速度为0
          uploadSpeed: 0,
          numPeers: 0,
          size: Number(t.size) || 0,             // 转换BigInt为Number
          timeRemaining: null,
          isPaused: t.isPaused || false, // 确保使用相同的字段名
          done: t.progress === 1,
          ready: true,
          isDatabase: true, // 标记为仅存在于数据库中
          dateAdded: t.dateAdded,
          dateCompleted: t.dateCompleted,
          files: t.files ? t.files.map(f => ({
            name: f.name,
            path: f.path,
            size: Number(f.size) || 0,  // 转换BigInt为Number
            progress: f.progress
          })) : []
        }))
    ];
    
    // 使用序列化函数处理结果
    res.json(torrentService.serializeBigInt(mergedTorrents));
  } catch (error) {
    logger.error(`获取种子列表错误: ${error.message}`);
    res.status(500).json({ error: '获取种子列表失败' });
  }
});

// API: 获取单个种子信息
router.get('/torrents/:infoHash', async (req, res) => {
  const { infoHash } = req.params;
  
  try {
    // 先尝试从活动种子中查找
    const activeTorrent = client.torrents.find(t => t.infoHash === infoHash);
    
    if (activeTorrent) {
      const info = {
        infoHash: activeTorrent.infoHash,
        name: activeTorrent.name,
        magnetURI: activeTorrent.magnetURI,
        progress: activeTorrent.progress,
        downloadSpeed: activeTorrent.downloadSpeed,
        uploadSpeed: activeTorrent.uploadSpeed,
        numPeers: activeTorrent.numPeers,
        downloaded: activeTorrent.downloaded,
        uploaded: activeTorrent.uploaded,
        timeRemaining: activeTorrent.timeRemaining,
        size: activeTorrent.length,
        files: activeTorrent.files.map(f => ({
          name: f.name,
          path: f.path,
          size: f.length
        }))
      };
      return res.json(torrentService.serializeBigInt(info));
    }
    
    // 如果不是活动种子，从数据库查找
    const dbTorrent = await dbService.getTorrentByInfoHash(infoHash);
    if (dbTorrent) {
      // 格式化数据库对象，处理BigInt
      const torrentData = {
        ...dbTorrent,
        downloaded: Number(dbTorrent.downloaded) || 0,
        uploaded: Number(dbTorrent.uploaded) || 0,
        size: Number(dbTorrent.size) || 0,
        files: dbTorrent.files ? dbTorrent.files.map(f => ({
          name: f.name,
          path: f.path,
          size: Number(f.size) || 0,
          progress: f.progress
        })) : []
      };
      return res.json(torrentService.serializeBigInt(torrentData));
    }
    
    // 如果都找不到，返回404
    return res.status(404).json({ error: '找不到种子' });
  } catch (error) {
    logger.error(`获取种子信息错误: ${error.message}`);
    res.status(500).json({ error: '获取种子信息失败' });
  }
});

// API: 删除种子
router.delete('/torrent/:infoHash', async (req, res) => {
  const { infoHash } = req.params;
  const { deleteFiles } = req.query;
  
  try {
    logger.info(`删除种子: ${infoHash}, 删除文件: ${deleteFiles}`);
    
    // 首先在客户端中查找并删除种子
    let torrentRemoved = false;
    try {
      // 安全地检查种子是否存在 - 使用torrents数组而不是直接get
      const torrent = client.torrents.find(t => t.infoHash === infoHash);
      
      if (torrent) {
        // 从客户端中删除
        client.remove(infoHash, { destroyStore: deleteFiles === 'true' });
        torrentRemoved = true;
        logger.info(`从WebTorrent客户端中移除种子: ${infoHash}`);
      } else {
        logger.warn(`在WebTorrent客户端中找不到种子: ${infoHash}`);
      }
    } catch (err) {
      logger.warn(`从客户端删除种子错误: ${err.message}`);
    }
    
    // 如果设置了删除文件，删除磁盘上的文件
    if (deleteFiles === 'true') {
      try {
        const dirDeleted = await diskManager.deleteTorrentFiles(infoHash);
        if (dirDeleted) {
          logger.info(`成功删除种子文件: ${infoHash}`);
        } else {
          logger.warn(`没有找到可删除的种子文件: ${infoHash}`);
        }
      } catch (err) {
        logger.error(`删除种子文件错误: ${err.message}`);
        // 继续流程，不中断操作
      }
    }
    
    // 从数据库中删除记录
    try {
      // 直接删除数据库记录，不再使用标记为已删除
      await dbService.deleteTorrent(infoHash);
      logger.info(`从数据库中删除种子记录: ${infoHash}`);
    } catch (dbErr) {
      logger.error(`从数据库删除种子记录失败: ${dbErr.message}`);
      // 如果客户端删除成功，仍然返回成功
      if (!torrentRemoved) {
        throw dbErr; // 只有当客户端也没有删除成功时才抛出错误
      }
    }
    
    // 从内存种子映射中移除
    if (torrentService.torrents.has(infoHash)) {
      torrentService.torrents.delete(infoHash);
      logger.info(`从内存映射中移除种子: ${infoHash}`);
    }
    
    res.json({ success: true, message: '种子已删除' });
  } catch (error) {
    logger.error(`删除种子错误: ${error.message}`);
    res.status(500).json({ error: '删除种子失败: ' + error.message });
  }
});

// API: 暂停/恢复种子
router.post('/toggle/:infoHash', async (req, res) => {
  try {
    const { infoHash } = req.params;
    
    if (!infoHash) {
      return res.status(400).json({
        success: false,
        error: '缺少infoHash参数'
      });
    }
    
    const result = await torrentService.toggleTorrentState(infoHash);
    return res.json(result);
  } catch (err) {
    logger.error(`切换种子状态失败: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: `切换种子状态失败: ${err.message}`
    });
  }
});

// API: 获取种子中的文件
router.get('/files/:infoHash', async (req, res) => {
  try {
    const { infoHash } = req.params;
    
    if (!infoHash) {
      return res.status(400).json({
        success: false,
        error: '缺少infoHash参数'
      });
    }
    
    // 尝试从WebTorrent客户端获取
    const torrent = client.get(infoHash);
    if (torrent && torrent.files && torrent.files.length > 0) {
      // 添加日志，以帮助调试
      logger.info(`获取种子文件列表 ${infoHash} (WebTorrent), 文件数: ${torrent.files.length}`);
      
      // 获取文件级进度的更准确信息
      const fileList = torrent.files.map((file, index) => {
        // 获取文件级别的进度
        let fileProgress = 0;
        
        try {
          // 使用文件自身的progress属性获取进度
          if (typeof file.progress === 'function') {
            // 某些WebTorrent版本中progress是一个函数
            fileProgress = file.progress();
          } else if (typeof file.progress === 'number') {
            // 其他版本中可能直接是数值
            fileProgress = file.progress;
          } else {
            // 如果没有直接的进度属性，尝试计算
            // 注意：这可能不是100%准确的
            fileProgress = webtorrentClient.calculateFileProgress(torrent, file);
          }
        } catch (err) {
          logger.warn(`计算文件进度失败: ${err.message}`);
          // 如果无法获取文件级别的进度，使用整个种子的进度
          fileProgress = torrent.progress || 0;
        }
        
        return {
          index,
          name: file.name || `未命名文件_${index}`, // 确保文件名始终存在
          path: file.path,
          length: file.length,
          progress: Math.round(fileProgress * 100) / 100, // 保留两位小数
          done: fileProgress >= 1,
          // 同时提供两种URL格式以兼容
          streaming_url: `/api/stream/${infoHash}/${encodeURIComponent(file.name || `未命名文件_${index}`)}`,
          stream_by_index_url: `/stream/${infoHash}/${index}`,
          download_url: `/download/${infoHash}/${index}`
        };
      });
      
      // 使用serializeBigInt处理响应
      return res.json(torrentService.serializeBigInt({
        success: true,
        infoHash,
        name: torrent.name || infoHash,
        files: fileList
      }));
    }
    
    // 如果WebTorrent和备用引擎都没有文件信息，尝试从数据库获取
    try {
      const dbTorrent = await dbService.getTorrentByInfoHash(infoHash);
      if (dbTorrent && dbTorrent.files && dbTorrent.files.length > 0) {
        logger.info(`从数据库获取种子文件列表: ${infoHash}, 文件数: ${dbTorrent.files.length}`);
        
        const fileList = dbTorrent.files.map((file, index) => ({
          index,
          name: file.name || `未命名文件_${index}`, // 确保文件名始终存在
          path: file.path,
          length: Number(file.size) || 0,
          progress: file.progress || 0,
          done: file.progress >= 1,
          // 同时提供两种URL格式以兼容
          streaming_url: `/api/stream/${infoHash}/${encodeURIComponent(file.name || `未命名文件_${index}`)}`,
          stream_by_index_url: `/stream/${infoHash}/${index}`,
          download_url: `/download/${infoHash}/${index}`
        }));
        
        // 使用serializeBigInt处理响应
        return res.json(torrentService.serializeBigInt({
          success: true,
          infoHash,
          name: dbTorrent.name || infoHash,
          files: fileList
        }));
      }
    } catch (dbErr) {
      logger.error(`从数据库获取种子文件列表失败: ${dbErr.message}`);
    }
    
    // 如果真的什么都没找到，返回空列表但不报错
    return res.json({
      success: true,
      infoHash,
      name: infoHash,
      files: [],
      message: '未找到文件信息，但种子可能正在下载中'
    });
  } catch (err) {
    logger.error(`获取文件列表失败: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: `获取文件列表失败: ${err.message}`
    });
  }
});

// 新增API：选择要下载的文件
router.post('/select/:infoHash', (req, res) => {
  try {
    const { infoHash } = req.params;
    const { selectedFiles } = req.body;
    
    logger.info(`收到文件选择请求: ${infoHash}, 选择的文件: ${selectedFiles.length}`);
    
    if (!infoHash) {
      return res.status(400).json({
        success: false,
        error: '缺少infoHash参数'
      });
    }
    
    if (!Array.isArray(selectedFiles)) {
      return res.status(400).json({
        success: false,
        error: '无效的文件选择'
      });
    }
    
    // 尝试从WebTorrent客户端获取种子
    const torrent = client.get(infoHash);
    if (torrent) {
      if (!torrent.files || torrent.files.length === 0) {
        return res.status(404).json({
          success: false,
          error: '种子中没有文件'
        });
      }
      
      // 创建选择集合，用于快速查询
      const selectedSet = new Set(selectedFiles);
      
      // 遍历文件，选择或取消选择
      torrent.files.forEach((file, index) => {
        if (selectedSet.has(index)) {
          logger.info(`选择文件: ${file.name}`);
          file.select();
        } else {
          logger.info(`跳过文件: ${file.name}`);
          file.deselect();
        }
      });
      
      // 更新内存中的种子信息
      const torrentInfo = torrentService.torrents.get(infoHash);
      if (torrentInfo && torrentInfo.files) {
        torrentInfo.files.forEach((file, index) => {
          file.selected = selectedSet.has(index);
        });
        torrentService.torrents.set(infoHash, torrentInfo);
      }
      
      // 更新数据库中的文件选择状态
      dbService.getTorrentByInfoHash(infoHash)
        .then(record => {
          if (record && record.id) {
            // 更新文件选择状态
            dbService.updateTorrentFileSelection(record.id, selectedFiles)
              .catch(err => logger.error(`更新文件选择状态失败: ${err.message}`));
          }
        })
        .catch(err => logger.error(`查找种子记录失败: ${err.message}`));
      
      return res.json({
        success: true,
        message: `已选择${selectedFiles.length}个文件下载`,
        selectedFiles
      });
    }
       
    return res.status(404).json({
      success: false,
      error: '找不到种子'
    });
  } catch (err) {
    logger.error(`选择文件失败: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: `选择文件失败: ${err.message}`
    });
  }
});

// 获取系统状态
router.get('/status', (req, res) => {
  const stats = systemMonitor.getStatus();
  const diskInfo = diskManager.getDiskInfo();
  const dhtInfo = dhtEnhancer ? dhtEnhancer.getStatus() : {};
  
  Promise.all([stats, diskInfo, dhtInfo])
    .then(([stats, diskInfo, dhtInfo]) => {
      res.json({
        system: stats,
        disk: diskInfo || {},
        dht: dhtInfo,
        torrents: client.torrents.map(t => ({
          infoHash: t.infoHash,
          name: t.name,
          progress: Math.round(t.progress * 100),
          downloadSpeed: t.downloadSpeed,
          numPeers: t.numPeers,
          paused: t.paused
        }))
      });
    })
    .catch(err => {
      logger.error(`获取状态信息失败: ${err.message}`);
      res.status(500).json({ error: '获取状态失败' });
    });
});

export default router; 