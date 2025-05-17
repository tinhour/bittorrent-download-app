import path from 'path';
import logger from '../utils/logger.js';
import dbService from './db-service.js';
import webtorrentClient from './webtorrent-client.js';
import trackerUtils from '../utils/tracker-utils.js';
import fs from 'fs';
import os from 'os';
import diskManager from './disk-manager.js';

// 存储所有种子信息的Map
const torrents = new Map();

// 添加种子
function addTorrent(magnetURI) {
  return new Promise((resolve, reject) => {
    // 添加超时机制
    const timeout = setTimeout(() => {
      logger.error('WebTorrent连接超时(60秒)，下载失败');
      reject(new Error('连接超时，请稍后重试'));
    }, 60000); // 60秒超时
    
    logger.info('开始添加种子:', magnetURI);
    
    try {
      // 提取并验证infoHash
      let infoHash = '';
      if (magnetURI.includes('magnet:?xt=urn:btih:')) {
        const infoHashPart = magnetURI.split('magnet:?xt=urn:btih:')[1].split('&')[0];
        infoHash = trackerUtils.normalizeInfoHash(infoHashPart);
        logger.info(`提取到infoHash: ${infoHash} (长度: ${infoHash.length})`);
        
        // 检查是否已存在此种子实例
        try {
          // 使用安全的方式检查种子是否存在
          const existingTorrent = webtorrentClient.client.get(infoHash);
          
          if (existingTorrent) {
            logger.info(`找到现有种子实例 (${infoHash})`);
            logger.info('种子对象属性:', Object.keys(existingTorrent).join(', '));
            
            // 检查是否是合法的WebTorrent实例
            if (typeof existingTorrent.on === 'function') {
              logger.info('种子是标准WebTorrent实例，可以监听事件');
              
              // 由于存在但未被正确初始化，最安全的方法是移除并重新添加
              logger.info('移除现有实例并重新添加以确保正确初始化');
              
              try {
                webtorrentClient.client.remove(infoHash, (err) => {
                  if (err) {
                    logger.error(`移除现有实例出错: ${err.message}`);
                    // 仍然尝试添加新实例
                    addNewTorrent();
                  } else {
                    logger.info('成功移除现有实例，准备添加新实例');
                    // 短暂延迟后添加新实例
                    setTimeout(() => {
                      addNewTorrent();
                    }, 1000);
                  }
                });
                return;
              } catch (removeError) {
                logger.error(`移除现有实例时出现异常: ${removeError.message}`);
                // 继续尝试添加新种子
              }
            } else {
              logger.info('种子不是标准WebTorrent实例，无法监听事件，将创建新实例');
              // 移除不完整的种子实例
              try {
                webtorrentClient.client.remove(infoHash);
                logger.info(`移除不完整的种子实例: ${infoHash}`);
              } catch (removeErr) {
                logger.error(`移除不完整种子实例失败: ${removeErr.message}`);
              }
            }
          } else {
            logger.info(`未找到现有种子实例，创建新实例: ${infoHash}`);
          }
        } catch (existingErr) {
          logger.error(`检查现有种子时出错: ${existingErr.message}`);
        }
      } else {
        logger.warn('无法从磁力链接提取infoHash');
      }
      
      // 添加新种子的函数
      addNewTorrent();
      
      // 内部函数：添加新种子
      function addNewTorrent() {
        try {
          // 定义种子添加回调函数
          const onTorrent = (torrent) => {
            try {
              clearTimeout(timeout);
              
              if (!torrent || !torrent.infoHash) {
                logger.error('添加种子成功但返回的种子对象无效');
                reject(new Error('返回的种子对象无效'));
                return;
              }
              
              logger.info('种子已添加，infohash:', torrent.infoHash);
              
              // 保留原始种子名称作为目录名
              const torrentName = torrent.name || torrent.infoHash;
              // 不再修改torrent.name为infoHash
              logger.info(`保持原始保存目录名称: ${torrentName}`);
              
              // 创建初始种子信息
              const torrentInfo = {
                infoHash: torrent.infoHash,
                magnetURI,
                name: torrentName || '未知种子', // 保存原始名称用于显示
                files: [],
                videoFile: null,
                videoPath: null,
                status: 'metadata',
                error: null,
                createdAt: new Date(),
                engine: 'webtorrent' // 标记使用的引擎
              };
              
              // 立即保存种子信息，稍后更新文件信息
              torrents.set(torrent.infoHash, torrentInfo);
              resolve(torrentInfo);
              
              // 设置连接相关事件
              torrent.on('wire', (wire, addr) => {
                logger.info(`[webtorrent] [${torrent.name || torrent.infoHash}] 连接到节点: ${addr}`);
              });
              
              // 处理元数据
              if (torrent.files && torrent.files.length) {
                processMetadata(torrent, torrentInfo);
              } else {
                // 监听元数据事件
                logger.info(`[${torrent.infoHash}] 等待获取元数据...`);
                torrent.once('metadata', () => {
                  logger.info(`[${torrent.infoHash}] 成功获取元数据`);
                  processMetadata(torrent, torrentInfo);
                });
              }
              
              // 设置事件监听
              webtorrentClient.setupTorrentEvents(torrent, torrentInfo, 
                (torrent) => webtorrentClient.addMoreTrackersToTorrent(torrent, trackerUtils.getDefaultTrackers()));
              
              // 启用PEX和LSD扩展
              webtorrentClient.enablePeerDiscovery(torrent);
            } catch (callbackError) {
              logger.error(`处理种子回调时出错: ${callbackError.message}`);
              reject(callbackError);
            }
          };
          
          // 使用增强的磁力链接
          const enhancedMagnet = trackerUtils.getEnhancedMagnetURI(magnetURI);
          logger.info('使用增强的磁力链接添加种子');
          
          // 添加种子
          try {
            webtorrentClient.client.add(enhancedMagnet, { 
              path: webtorrentClient.downloadPath,
              maxWebConns: 50,
              storeName: infoHash // 使用infoHash作为存储目录名，而不是种子名
            }, onTorrent);
          } catch (addError) {
            logger.error(`客户端添加种子时出错: ${addError.message}`);
            clearTimeout(timeout);
            reject(addError);
          }
        } catch (newTorrentError) {
          logger.error(`添加新种子准备过程中出错: ${newTorrentError.message}`);
          clearTimeout(timeout);
          reject(newTorrentError);
        }
      }
      
    } catch (err) {
      clearTimeout(timeout);
      logger.error('添加种子过程中出错:', err.message);
      reject(err);
    }
  });
}

// 处理WebTorrent元数据
function processMetadata(torrent, torrentInfo) {
  logger.info('获取到种子元数据，名称:', torrent.name);
  logger.info('种子包含文件数:', torrent.files.length);
  
  // 更新种子信息
  torrentInfo.name = torrent.originalName || torrentInfo.name;
  torrentInfo.status = 'downloading';
  
  // 打印所有文件
  logger.info('种子中的文件:');
  const filesList = [];
  torrent.files.forEach((file, index) => {
    const fileInfo = {
      index,
      name: file.name,
      size: file.length,
      path: file.path,
      selected: true // 默认所有文件都选中
    };
    filesList.push(fileInfo);
    logger.info(`文件 ${index + 1}: ${file.name} (${(file.length / 1024 / 1024).toFixed(2)} MB)`);
  });
  
  torrentInfo.files = filesList;
  
  // 默认只选择视频文件自动下载
  const videoExts = ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.mpg', '.mpeg', '.wmv'];
  
  // 只选择视频文件，自动跳过其他文件
  torrent.files.forEach((file, index) => {
    const ext = path.extname(file.name).toLowerCase();
    const isVideo = videoExts.includes(ext);
    
    if (isVideo) {
      logger.info(`自动选择视频文件: ${file.name}`);
      file.select();
    } else {
      logger.info(`跳过非视频文件: ${file.name}`);
      file.deselect();
      filesList[index].selected = false;
    }
  });
  
  // 寻找视频文件
  const videoFile = torrent.files.find(f => {
    const ext = path.extname(f.name).toLowerCase();
    return videoExts.includes(ext);
  });
  
  if (videoFile) {
    logger.info(`找到视频文件: ${videoFile.name}, 大小: ${(videoFile.length / 1024 / 1024).toFixed(2)} MB`);
    
    torrentInfo.videoFile = {
      index: torrent.files.indexOf(videoFile),
      name: videoFile.name,
      size: videoFile.length,
      path: videoFile.path
    };
    
    // 使用种子名称作为目录名，因为WebTorrent默认以种子名创建目录
    const torrentDir = path.join(webtorrentClient.downloadPath, torrent.name);
    
    // 同时记录infoHash路径，以便在需要时可以查找
    const infoHashDir = path.join(webtorrentClient.downloadPath, torrent.infoHash);
    
    // 在torrentInfo中保存两种路径，便于后续查找
    torrentInfo.torrentNameDir = torrentDir;
    torrentInfo.infoHashDir = infoHashDir;
    
    // 确保种子目录存在 - 实际WebTorrent会自己创建
    try {
      if (!fs.existsSync(torrentDir)) {
        logger.info(`种子名称目录尚未创建: ${torrentDir} (WebTorrent将自动创建)`);
      } else {
        logger.info(`种子名称目录已存在: ${torrentDir}`);
      }
    } catch (err) {
      logger.error(`检查种子目录失败: ${err.message}`);
    }
    
    // 设置主要保存路径为种子名称路径
    const savePath = path.join(torrentDir, videoFile.name);
    torrentInfo.videoPath = savePath;
    
    // 保存备用路径（infoHash路径）
    const infoHashPath = path.join(infoHashDir, videoFile.name);
    torrentInfo.infoHashVideoPath = infoHashPath;
    
    // 详细保存路径信息
    logger.info('文件将保存到以下绝对路径:');
    logger.info(`- 主要路径(种子名): ${path.resolve(savePath)}`);
    logger.info(`- 备用路径(infoHash): ${path.resolve(infoHashPath)}`);
    logger.info(`- 种子名称: ${torrent.name}`);
    logger.info(`- 种子infoHash: ${torrent.infoHash}`);
    
    // WebTorrent会将文件保存到其默认路径，我们不需要创建额外的文件副本
    logger.info('WebTorrent将文件保存到:', savePath);
    
    // 监视文件创建
    const checkFileExists = () => {
      try {
        if (fs.existsSync(savePath)) {
          const stats = fs.statSync(savePath);
          logger.info(`文件已存在: ${savePath}, 大小: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
          return true;
        }
        return false;
      } catch (err) {
        logger.error(`检查文件存在性失败: ${err.message}`);
        return false;
      }
    };
    
    // 立即检查文件是否已存在
    if (checkFileExists()) {
      logger.info('文件已经存在，可能是之前下载的');
    } else {
      logger.info('文件尚未创建，等待下载...');
      
      // 每10秒检查一次文件是否创建
      const fileCheckInterval = setInterval(() => {
        if (checkFileExists()) {
          logger.info('文件已成功创建!');
          clearInterval(fileCheckInterval);
        }
      }, 10000);
      
      // 60分钟后停止检查
      setTimeout(() => {
        clearInterval(fileCheckInterval);
      }, 60 * 60 * 1000);
    }
  } else {
    logger.error('没有找到视频文件，可用文件:');
    torrent.files.forEach(f => logger.info(`- ${f.name}`));
    torrentInfo.error = '没有找到视频文件';
  }
  
  // 保存种子信息到数据库
  const torrentData = {
    infoHash: torrent.infoHash,
    name: torrentInfo.name,
    magnetURI: torrent.magnetURI,
    size: torrent.length || 0,
    progress: torrent.progress,
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    numPeers: torrent.numPeers,
    numSeeds: torrent.numSeeds,
    saveLocation: webtorrentClient.downloadPath,
    // 将metadata转为JSON字符串存储
    metadata: JSON.stringify({
      name: torrentInfo.name,
      comment: torrent.comment,
      createdBy: torrent.createdBy,
      announceList: torrent.announce,
      private: torrent.private,
      creationDate: torrent.creationDate
    })
  };
  
  // 保存到数据库
  dbService.createOrUpdateTorrent(torrentData)
    .then(record => {
      // 如果有文件列表，保存文件信息
      if (torrent.files && torrent.files.length > 0) {
        const fileData = torrent.files.map(file => ({
          path: file.path,
          name: file.name,
          size: file.length,
          progress: 0, // 初始进度
          isSelected: true
        }));
        
        dbService.addTorrentFiles(record.id, fileData)
          .catch(err => logger.error(`保存种子文件列表失败: ${err.message}`));
      }
    })
    .catch(err => logger.error(`保存种子信息到数据库失败: ${err.message}`));
  
  // 更新种子信息
  torrents.set(torrent.infoHash, torrentInfo);
}

// 从数据库恢复下载
async function restoreDownloadsFromDatabase() {
  try {
    logger.info('开始从数据库恢复下载...');
    
    // 获取所有未删除的种子
    const activeTorrents = await dbService.getActiveTorrents();
    
    if (activeTorrents.length === 0) {
      logger.info('没有未完成的下载需要恢复');
      return;
    }
    
    logger.info(`找到 ${activeTorrents.length} 个需要恢复的下载`);
    
    // 逐个恢复下载
    for (const torrent of activeTorrents) {
      try {
        logger.info(`尝试恢复下载: ${torrent.name || torrent.infoHash} (进度: ${Math.round(torrent.progress * 100)}%)`);
        
        // 检查是否已经在客户端中
        const existingTorrent = webtorrentClient.client.get(torrent.infoHash);
        if (existingTorrent) {
          logger.info(`种子已在客户端中: ${torrent.infoHash}`);
          continue;
        }
        
        // 检查是否暂停状态
        if (torrent.isPaused) {
          logger.info(`跳过暂停的种子: ${torrent.name || torrent.infoHash}`);
          continue;
        }
        
        // 使用增强的磁力链接
        let enhancedMagnet;
        try {
          enhancedMagnet = trackerUtils.getEnhancedMagnetURI(torrent.magnetURI);
        } catch (err) {
          logger.error(`增强磁力链接失败，使用原始链接: ${err.message}`);
          enhancedMagnet = torrent.magnetURI;
        }
        
        // 添加到客户端
        webtorrentClient.client.add(enhancedMagnet, { 
          path: webtorrentClient.downloadPath,
          maxWebConns: 50,
          storeName: torrent.infoHash // 使用infoHash作为存储目录名
        }, (newTorrent) => {
          logger.info(`成功恢复下载: ${newTorrent.name || newTorrent.infoHash}`);
          
          // 保持原始种子名称，WebTorrent将以种子名称创建目录
          const originalName = newTorrent.name;
          logger.info(`保持原始种子名称: ${originalName} (infoHash: ${newTorrent.infoHash})`);
          
          // 设置事件监听
          webtorrentClient.setupTorrentEvents(newTorrent, {
            infoHash: newTorrent.infoHash,
            name: newTorrent.name,
            files: []
          }, (torrent) => webtorrentClient.addMoreTrackersToTorrent(torrent, trackerUtils.getDefaultTrackers()));
          
          // 只选择之前已选择的文件（如果信息可用）
          if (torrent.files && torrent.files.length > 0 && newTorrent.files && newTorrent.files.length > 0) {
            try {
              // 文件数量应该一致
              if (torrent.files.length === newTorrent.files.length) {
                torrent.files.forEach((fileRecord, index) => {
                  if (fileRecord.isSelected && index < newTorrent.files.length) {
                    newTorrent.files[index].select();
                    logger.info(`选择文件: ${newTorrent.files[index].name}`);
                  } else if (!fileRecord.isSelected && index < newTorrent.files.length) {
                    newTorrent.files[index].deselect();
                    logger.info(`取消选择文件: ${newTorrent.files[index].name}`);
                  }
                });
              } else {
                logger.warn(`文件数量不匹配，无法恢复文件选择状态: ${torrent.files.length} vs ${newTorrent.files.length}`);
              }
            } catch (fileErr) {
              logger.error(`恢复文件选择状态失败: ${fileErr.message}`);
            }
          }
        });
      } catch (err) {
        logger.error(`恢复下载失败: ${torrent.infoHash} - ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`从数据库恢复下载失败: ${err.message}`);
  }
}

// 暂停或恢复种子
async function toggleTorrentState(infoHash) {
  try {
    if (!infoHash) {
      throw new Error('缺少infoHash参数');
    }
    
    // 首先在数据库中查找种子记录
    const dbTorrent = await dbService.getTorrentByInfoHash(infoHash);
    if (!dbTorrent) {
      throw new Error(`未找到种子: ${infoHash}`);
    }
    
    const currentlyPaused = dbTorrent.isPaused;
    
    // 尝试从WebTorrent客户端切换状态
    const torrent = webtorrentClient.client.get(infoHash);
    if (torrent) {
      if (currentlyPaused) {
        // 恢复下载 - 使用更积极的方法强制重新开始下载
        try {
          // 方法1: 使用WebTorrent v5.x API 如果可用
          if (typeof torrent.resume === 'function') {
            logger.info(`使用resume()方法恢复种子: ${infoHash}`);
            torrent.resume();
          } else {
            // 方法2: WebTorrent v1.x 没有直接的resume方法
            logger.info(`使用select方法恢复种子: ${infoHash}`);
            if (torrent.files && Array.isArray(torrent.files)) {
              torrent.files.forEach(file => file.select());
            } else {
              logger.warn(`种子没有有效的files数组: ${infoHash}`);
            }
            // 设置暂停状态
            torrent.paused = false;
          }
          
          // 方法3: 主动添加更多tracker并重新连接DHT网络
          logger.info(`为种子添加更多tracker: ${infoHash}`);
          try {
            const addedTrackers = webtorrentClient.addMoreTrackersToTorrent(torrent, trackerUtils.getDefaultTrackers());
            logger.info(`已添加${addedTrackers}个tracker`);
          } catch (err) {
            logger.error(`添加tracker失败: ${err.message}`);
          }
          
          // 方法4: 触发DHT网络查找更多peer
          try {
            if (typeof dhtEnhancer.announceInfoHash === 'function') {
              logger.info(`使用DHT增强器查找更多peer: ${infoHash}`);
              dhtEnhancer.announceInfoHash(infoHash);
            } else {
              logger.warn('DHT增强器不支持announceInfoHash方法');
            }
          } catch (err) {
            logger.error(`DHT增强失败: ${err.message}`);
          }
          
          // 方法5: 如果torrent有reannounce方法，调用它重新公告到tracker
          if (typeof torrent.reannounce === 'function') {
            logger.info(`重新公告种子到tracker: ${infoHash}`);
            torrent.reannounce();
          }
        } catch (err) {
          logger.error(`强制恢复种子出错: ${err.message}`);
        }
        
        await dbService.resumeTorrent(infoHash);
        logger.info(`已恢复种子: ${infoHash}`);
      } else {
        // 暂停下载 - 使用WebTorrent v5.x API
        if (typeof torrent.pause === 'function') {
          torrent.pause();
        } else {
          // WebTorrent v1.x 没有直接的pause方法，可能使用deselect()
          if (torrent.files && Array.isArray(torrent.files)) {
            torrent.files.forEach(file => file.deselect());
          } else {
            logger.warn(`种子没有有效的files数组: ${infoHash}`);
          }
          // 设置暂停状态
          torrent.paused = true;
        }
        await dbService.pauseTorrent(infoHash);
        logger.info(`已暂停种子: ${infoHash}`);
      }
      
      return {
        success: true,
        infoHash,
        isPaused: !currentlyPaused,
        message: currentlyPaused ? '已恢复下载' : '已暂停下载'
      };
    }
    
    // 如果种子不在活动客户端中，但在数据库中存在
    // 直接更新数据库的状态
    if (currentlyPaused) {
      // 恢复下载 - 添加到客户端
      await dbService.resumeTorrent(infoHash);
      
      // 尝试添加回客户端
      const enhancedMagnet = trackerUtils.getEnhancedMagnetURI(dbTorrent.magnetURI);
      webtorrentClient.client.add(enhancedMagnet, { 
        path: webtorrentClient.downloadPath,
        maxWebConns: 50,
        storeName: torrent.infoHash // 使用infoHash作为存储目录名
      }, (newTorrent) => {
        logger.info(`从暂停状态恢复下载: ${newTorrent.name || newTorrent.infoHash}`);
        
        // 修改torrent.name为infoHash确保目录正确
        const originalName = newTorrent.name;
        newTorrent.name = newTorrent.infoHash;
        logger.info(`修改保存目录: 从 ${originalName} 改为 ${newTorrent.infoHash}`);
        
        // 设置事件监听
        webtorrentClient.setupTorrentEvents(newTorrent, {
          infoHash: newTorrent.infoHash,
          name: newTorrent.name,
          files: []
        }, (torrent) => webtorrentClient.addMoreTrackersToTorrent(torrent, trackerUtils.getDefaultTrackers()));
      });
      
      return {
        success: true,
        infoHash,
        isPaused: false,
        message: '已恢复下载，正在添加到下载队列'
      };
    } else {
      // 暂停下载 - 只需标记状态
      await dbService.pauseTorrent(infoHash);
      
      return {
        success: true,
        infoHash,
        isPaused: true,
        message: '已标记为暂停，将在下次启动服务器时生效'
      };
    }
  } catch (err) {
    logger.error(`切换种子状态失败: ${err.message}`);
    throw err;
  }
}

// 序列化处理BigInt
function serializeBigInt(obj) {
  return JSON.parse(JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? Number(value) : value
  ));
}

export default {
  addTorrent,
  processMetadata,
  restoreDownloadsFromDatabase,
  toggleTorrentState,
  serializeBigInt,
  torrents
}; 