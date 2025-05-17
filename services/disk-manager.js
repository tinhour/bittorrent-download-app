import fs from 'fs';
import path from 'path';
import config from '../config/index.js';
import logger from '../utils/logger.js';

class DiskManager {
  constructor() {
    this.downloadPath = config.DOWNLOAD_PATH;
    this.maxDiskSpace = config.DISK_SPACE_LIMIT || 10737418240; // 默认10GB
    this.cleanupInterval = config.CLEANUP_INTERVAL || 6 * 60 * 60 * 1000; // 默认6小时
    this.activeTorrents = new Set(); // 保存当前活动的种子hash
    
    // 记录配置信息到日志
    logger.info(`磁盘管理初始化: 下载路径=${this.downloadPath}`);
    logger.info(`磁盘空间限制: ${(this.maxDiskSpace / 1024 / 1024 / 1024).toFixed(2)}GB`);
    logger.info(`清理间隔: ${this.cleanupInterval / (60 * 60 * 1000)}小时`);
    
    // 确保下载目录存在
    this.ensureDownloadDirectory();
    
    // 启动定期清理
    this.startCleanupTask();
  }
  
  // 确保下载目录存在
  ensureDownloadDirectory() {
    try {
      if (!fs.existsSync(this.downloadPath)) {
        logger.info(`创建下载目录: ${this.downloadPath}`);
        fs.mkdirSync(this.downloadPath, { recursive: true });
        logger.info('下载目录创建成功');
      } else {
        logger.info(`下载目录已存在: ${this.downloadPath}`);
      }
      
      // 检查权限
      fs.accessSync(this.downloadPath, fs.constants.R_OK | fs.constants.W_OK);
      logger.info('下载目录有读写权限');
    } catch (err) {
      logger.error('下载目录设置失败', err);
      // 尝试使用临时目录
      this.downloadPath = path.join(process.env.TEMP || '/tmp', 'webtorrent-downloads');
      logger.info(`尝试使用备用下载目录: ${this.downloadPath}`);
      
      try {
        if (!fs.existsSync(this.downloadPath)) {
          fs.mkdirSync(this.downloadPath, { recursive: true });
        }
        fs.accessSync(this.downloadPath, fs.constants.R_OK | fs.constants.W_OK);
        logger.info('备用下载目录设置成功');
      } catch (fallbackErr) {
        logger.error('备用下载目录设置也失败', fallbackErr);
        throw new Error('无法设置下载目录，请检查权限和路径');
      }
    }
  }
  
  // 注册活动种子
  registerTorrent(infoHash) {
    this.activeTorrents.add(infoHash);
    logger.debug(`注册活动种子: ${infoHash}`);
  }
  
  // 取消注册种子
  unregisterTorrent(infoHash) {
    this.activeTorrents.delete(infoHash);
    logger.debug(`取消注册种子: ${infoHash}`);
  }
  
  // 获取目录大小
  async getDirSize(dirPath) {
    let size = 0;
    
    try {
      const files = await fs.promises.readdir(dirPath);
      
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = await fs.promises.stat(filePath);
        
        if (stats.isDirectory()) {
          size += await this.getDirSize(filePath);
        } else {
          size += stats.size;
        }
      }
      
      return size;
    } catch (err) {
      logger.error(`获取目录大小失败: ${dirPath}`, err);
      return size;
    }
  }
  
  // 获取目录中最旧的非活动种子
  async getOldestInactiveTorrent() {
    try {
      const items = await fs.promises.readdir(this.downloadPath);
      const dirStats = [];
      
      for (const item of items) {
        // 跳过活动种子
        if (this.activeTorrents.has(item)) continue;
        
        const itemPath = path.join(this.downloadPath, item);
        try {
          const stats = await fs.promises.stat(itemPath);
          if (stats.isDirectory()) {
            dirStats.push({
              path: itemPath,
              mtime: stats.mtime,
              name: item
            });
          }
        } catch (err) {
          logger.error(`获取文件状态失败: ${itemPath}`, err);
        }
      }
      
      // 按修改时间排序（最旧的优先）
      dirStats.sort((a, b) => a.mtime - b.mtime);
      
      return dirStats.length > 0 ? dirStats[0] : null;
    } catch (err) {
      logger.error('获取最旧种子失败', err);
      return null;
    }
  }
  
  // 删除目录及其内容
  async removeDirectory(dirPath) {
    try {
      await fs.promises.rm(dirPath, { recursive: true, force: true });
      logger.info(`已删除目录: ${dirPath}`);
      return true;
    } catch (err) {
      logger.error(`删除目录失败: ${dirPath}`, err);
      return false;
    }
  }
  
  // 执行清理
  async performCleanup() {
    logger.info('开始执行磁盘清理检查...');
    
    try {
      // 获取当前下载目录大小
      const currentSize = await this.getDirSize(this.downloadPath);
      logger.info(`当前下载目录大小: ${(currentSize / 1024 / 1024).toFixed(2)} MB，限制: ${(this.maxDiskSpace / 1024 / 1024).toFixed(2)} MB`);
      
      // 确保maxDiskSpace有效
      if (!this.maxDiskSpace || this.maxDiskSpace <= 0) {
        logger.warn('磁盘空间限制无效，设置为默认值10GB');
        this.maxDiskSpace = 10737418240; // 默认10GB
      }
      
      // 如果低于阈值，不需要清理
      if (currentSize < this.maxDiskSpace) {
        logger.info(`磁盘使用在限制范围内 (${(currentSize / this.maxDiskSpace * 100).toFixed(2)}%)，无需清理`);
        return;
      }
      
      // 需要清理
      logger.warn(`磁盘使用超出限制 (${(currentSize / this.maxDiskSpace * 100).toFixed(2)}%)，开始清理旧种子`);
      
      // 循环清理直到大小降到阈值以下或没有更多可清理的内容
      let sizeToFree = currentSize - this.maxDiskSpace * 0.9; // 清理到90%的阈值
      let cleanupAttempts = 0;
      
      while (sizeToFree > 0 && cleanupAttempts < 10) { // 最多尝试10次，防止无限循环
        cleanupAttempts++;
        
        // 获取最旧的非活动种子
        const oldestTorrent = await this.getOldestInactiveTorrent();
        
        if (!oldestTorrent) {
          logger.warn('没有可清理的非活动种子，清理终止');
          break;
        }
        
        logger.info(`准备清理旧种子: ${oldestTorrent.name}`);
        
        // 获取此种子占用的空间
        const torrentSize = await this.getDirSize(oldestTorrent.path);
        
        // 删除种子
        const removed = await this.removeDirectory(oldestTorrent.path);
        
        if (removed) {
          sizeToFree -= torrentSize;
          logger.info(`清理释放了 ${(torrentSize / 1024 / 1024).toFixed(2)} MB 空间`);
        }
      }
      
      if (cleanupAttempts >= 10) {
        logger.warn('达到最大清理尝试次数，清理终止');
      }
      
      // 再次检查大小
      const newSize = await this.getDirSize(this.downloadPath);
      logger.info(`清理后下载目录大小: ${(newSize / 1024 / 1024).toFixed(2)} MB (${(newSize / this.maxDiskSpace * 100).toFixed(2)}%)`);
      
    } catch (err) {
      logger.error(`执行磁盘清理失败: ${err.message}`);
    }
  }
  
  // 启动定期清理任务
  startCleanupTask() {
    // 检查清理间隔是否合理
    if (!this.cleanupInterval || this.cleanupInterval < 3600000) { // 至少1小时
      logger.warn(`清理间隔 ${this.cleanupInterval} 太短，设置为默认值6小时`);
      this.cleanupInterval = 6 * 60 * 60 * 1000;
    }
    
    logger.info(`启动磁盘清理任务，首次执行将在30分钟后，之后每 ${this.cleanupInterval / (60 * 60 * 1000)} 小时执行一次`);
    
    // 首次运行延迟30分钟，避免启动时就执行清理
    setTimeout(() => {
      logger.info('执行首次磁盘空间检查');
      this.performCleanup();
    }, 30 * 60 * 1000); // 30分钟后执行首次清理
    
    // 定期执行
    setInterval(() => {
      this.performCleanup();
    }, this.cleanupInterval);
  }
  
  // 获取磁盘信息
  async getDiskInfo() {
    try {
      const currentSize = await this.getDirSize(this.downloadPath);
      const usagePercent = (currentSize / this.maxDiskSpace * 100).toFixed(2);
      
      return {
        totalSpace: this.maxDiskSpace,
        usedSpace: currentSize,
        freeSpace: this.maxDiskSpace - currentSize,
        usagePercent: parseFloat(usagePercent),
        downloadPath: this.downloadPath,
        activeTorrents: [...this.activeTorrents]
      };
    } catch (err) {
      logger.error('获取磁盘信息失败', err);
      return null;
    }
  }
  
  // 删除种子文件
  async deleteTorrentFiles(infoHash) {
    if (!infoHash) {
      logger.error('无法删除文件：缺少infoHash');
      return false;
    }

    let deleted = false;
    // 1. 删除 infoHash 目录
    const infoHashPath = path.join(this.downloadPath, infoHash);
    if (fs.existsSync(infoHashPath)) {
      logger.info(`删除infoHash目录及内容: ${infoHashPath}`);
      await this.recursiveDelete(infoHashPath);
      logger.info(`成功删除infoHash目录: ${infoHashPath}`);
      deleted = true;
    }

    // 2. 查数据库获取种子名称目录
    try {
      const dbService = (await import('./db-service.js')).default;
      const record = await dbService.getTorrentByInfoHash(infoHash);
      if (record && record.name) {
        const namePath = path.join(this.downloadPath, record.name);
        if (fs.existsSync(namePath)) {
          logger.info(`删除种子名称目录及内容: ${namePath}`);
          await this.recursiveDelete(namePath);
          logger.info(`成功删除种子名称目录: ${namePath}`);
          deleted = true;
        }
      }
    } catch (err) {
      logger.warn('查找种子名称目录时出错: ' + err.message);
    }

    if (!deleted) {
      logger.warn(`找不到要删除的目录: ${infoHashPath} 或对应种子名称目录`);
    }
    return deleted;
  }
  
  // 递归删除目录及其内容
  async recursiveDelete(dirPath) {
    try {
      if (!fs.existsSync(dirPath)) {
        return;
      }
      
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      
      // 先删除所有文件和子目录
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        
        if (entry.isDirectory()) {
          // 递归删除子目录
          await this.recursiveDelete(fullPath);
        } else {
          // 删除文件
          try {
            await fs.promises.unlink(fullPath);
            logger.debug(`删除文件: ${fullPath}`);
          } catch (err) {
            logger.error(`删除文件失败: ${fullPath} - ${err.message}`);
          }
        }
      }
      
      // 最后删除空目录
      await fs.promises.rmdir(dirPath);
      logger.debug(`删除目录: ${dirPath}`);
    } catch (error) {
      logger.error(`递归删除目录失败: ${dirPath} - ${error.message}`);
      throw error;
    }
  }
}

export default new DiskManager(); 