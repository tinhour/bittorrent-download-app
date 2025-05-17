import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger.js';

// 初始化Prisma客户端
const prisma = new PrismaClient({
  // 增加转换器，处理BigInt
  log: ['warn', 'error']
});

// 在应用程序退出时关闭Prisma连接
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

// 辅助函数：处理BigInt转换
function convertBigInt(data) {
  if (data === null || data === undefined) {
    return data;
  }
  
  if (typeof data === 'bigint') {
    return Number(data);
  }
  
  if (Array.isArray(data)) {
    return data.map(item => convertBigInt(item));
  }
  
  if (typeof data === 'object') {
    const result = {};
    for (const key in data) {
      result[key] = convertBigInt(data[key]);
    }
    return result;
  }
  
  return data;
}

// 数据库服务类
const dbService = {
  /**
   * 创建或更新种子记录
   * @param {Object} torrentData - 种子数据对象
   * @returns {Promise<Object>} - 创建或更新的记录
   */
  async createOrUpdateTorrent(torrentData) {
    try {
      const { infoHash } = torrentData;
      
      // 检查记录是否已存在
      const existingRecord = await prisma.torrentRecord.findUnique({
        where: { infoHash }
      });
      
      if (existingRecord) {
        // 更新现有记录
        logger.info(`更新种子记录: ${infoHash}`);
        const updated = await prisma.torrentRecord.update({
          where: { infoHash },
          data: {
            ...torrentData,
            isDeleted: false, // 确保重新添加的种子不被标记为已删除
          },
        });
        return convertBigInt(updated);
      } else {
        // 创建新记录
        logger.info(`创建新种子记录: ${infoHash}`);
        const created = await prisma.torrentRecord.create({
          data: torrentData
        });
        return convertBigInt(created);
      }
    } catch (error) {
      logger.error(`创建/更新种子记录失败: ${error.message}`);
      throw error;
    }
  },

  /**
   * 更新种子进度信息
   * @param {string} infoHash - 种子的infoHash
   * @param {Object} progressData - 进度数据
   * @returns {Promise<Object>} - 更新的记录
   */
  async updateTorrentProgress(infoHash, progressData) {
    try {
      const updated = await prisma.torrentRecord.update({
        where: { infoHash },
        data: progressData
      });
      return convertBigInt(updated);
    } catch (error) {
      logger.error(`更新种子进度失败: ${error.message}`);
      // 如果记录不存在，不抛出错误
      if (error.code === 'P2025') {
        logger.warn(`尝试更新不存在的种子记录: ${infoHash}`);
        return null;
      }
      throw error;
    }
  },

  /**
   * 标记种子为已删除状态
   * @param {string} infoHash - 种子的infoHash
   * @returns {Promise<Object>} - 更新的记录
   */
  async markTorrentAsDeleted(infoHash) {
    try {
      const updated = await prisma.torrentRecord.update({
        where: { infoHash },
        data: { isDeleted: true }
      });
      return convertBigInt(updated);
    } catch (error) {
      logger.error(`标记种子为已删除状态失败: ${error.message}`);
      throw error;
    }
  },

  /**
   * 获取所有种子记录
   * @returns {Promise<Array>} - 种子记录数组
   */
  async getAllTorrents() {
    try {
      const records = await prisma.torrentRecord.findMany({
        include: { files: true },
        orderBy: { dateAdded: 'desc' }
      });
      
      return convertBigInt(records);
    } catch (error) {
      logger.error(`获取种子记录失败: ${error.message}`);
      throw error;
    }
  },

  /**
   * 根据infoHash获取种子记录
   * @param {string} infoHash - 种子的infoHash
   * @returns {Promise<Object|null>} - 种子记录或null
   */
  async getTorrentByInfoHash(infoHash) {
    try {
      const record = await prisma.torrentRecord.findUnique({
        where: { infoHash },
        include: { files: true }
      });
      
      return record ? convertBigInt(record) : null;
    } catch (error) {
      logger.error(`获取种子记录失败: ${error.message}`);
      throw error;
    }
  },

  /**
   * 为种子添加文件记录
   * @param {string} torrentId - 种子记录ID
   * @param {Array} files - 文件数组 
   * @returns {Promise<Array>} - 创建的文件记录
   */
  async addTorrentFiles(torrentId, files) {
    try {
      // 首先删除该种子的所有现有文件记录(如果有的话)
      await prisma.torrentFile.deleteMany({
        where: { torrentId }
      });
      
      // 创建新的文件记录
      const createPromises = files.map(file => {
        return prisma.torrentFile.create({
          data: {
            ...file,
            torrentId
          }
        });
      });
      
      return await Promise.all(createPromises);
    } catch (error) {
      logger.error(`添加种子文件记录失败: ${error.message}`);
      throw error;
    }
  },

  /**
   * 彻底删除种子记录及其文件
   * @param {string} infoHash - 种子的infoHash
   * @returns {Promise<boolean>} - 是否删除成功
   */
  async deleteTorrent(infoHash) {
    try {
      const record = await prisma.torrentRecord.findUnique({
        where: { infoHash }
      });
      
      if (!record) {
        logger.warn(`尝试删除不存在的种子记录: ${infoHash}`);
        return false;
      }
      
      // 删除种子记录(关联的文件会通过级联删除自动删除)
      await prisma.torrentRecord.delete({
        where: { id: record.id }
      });
      
      return true;
    } catch (error) {
      logger.error(`删除种子记录失败: ${error.message}`);
      throw error;
    }
  },

  /**
   * 清理已删除的旧记录
   * @param {number} olderThanDays - 删除几天前的记录
   * @returns {Promise<number>} - 删除的记录数量
   */
  async cleanupDeletedRecords(olderThanDays = 30) {
    try {
      const date = new Date();
      date.setDate(date.getDate() - olderThanDays);
      
      const result = await prisma.torrentRecord.deleteMany({
        where: {
          isDeleted: true,
          dateAdded: {
            lt: date
          }
        }
      });
      
      logger.info(`已清理 ${result.count} 条已删除的旧记录`);
      return result.count;
    } catch (error) {
      logger.error(`清理已删除记录失败: ${error.message}`);
      throw error;
    }
  },

  /**
   * 更新文件选择状态
   * @param {number} torrentId - 种子记录ID
   * @param {Array<number>} selectedIndices - 选中的文件索引数组
   * @returns {Promise<boolean>} - 是否更新成功
   */
  async updateTorrentFileSelection(torrentId, selectedIndices) {
    try {
      // 获取该种子下的所有文件
      const files = await prisma.torrentFile.findMany({
        where: { torrentId }
      });
      
      if (!files || files.length === 0) {
        logger.warn(`种子ID ${torrentId} 没有文件记录`);
        return false;
      }
      
      // 创建选择集，用于快速查找
      const selectedSet = new Set(selectedIndices);
      
      // 为每个文件更新选择状态
      const updatePromises = files.map((file, index) => {
        return prisma.torrentFile.update({
          where: { id: file.id },
          data: { isSelected: selectedSet.has(index) }
        });
      });
      
      await Promise.all(updatePromises);
      logger.info(`已更新种子ID ${torrentId} 的文件选择状态, 选中了 ${selectedIndices.length} 个文件`);
      
      return true;
    } catch (error) {
      logger.error(`更新文件选择状态失败: ${error.message}`);
      throw error;
    }
  },

  /**
   * 暂停种子下载
   * @param {string} infoHash - 种子的infoHash
   * @returns {Promise<Object>} - 更新的记录
   */
  async pauseTorrent(infoHash) {
    try {
      const updated = await prisma.torrentRecord.update({
        where: { infoHash },
        data: { isPaused: true }
      });
      return convertBigInt(updated);
    } catch (error) {
      logger.error(`暂停种子下载失败: ${error.message}`);
      throw error;
    }
  },

  /**
   * 恢复种子下载
   * @param {string} infoHash - 种子的infoHash
   * @returns {Promise<Object>} - 更新的记录
   */
  async resumeTorrent(infoHash) {
    try {
      const updated = await prisma.torrentRecord.update({
        where: { infoHash },
        data: { isPaused: false }
      });
      return convertBigInt(updated);
    } catch (error) {
      logger.error(`恢复种子下载失败: ${error.message}`);
      throw error;
    }
  },

  /**
   * 获取所有未暂停且未完成的种子记录
   * @returns {Promise<Array>} - 种子记录数组
   */
  async getActiveTorrents() {
    try {
      const records = await prisma.torrentRecord.findMany({
        where: {
          isDeleted: false,
          isPaused: false,
          progress: { lt: 1 } // 未完成的种子
        },
        include: { files: true }
      });
      
      return convertBigInt(records);
    } catch (error) {
      logger.error(`获取活跃种子记录失败: ${error.message}`);
      throw error;
    }
  },

  // 更新单个文件的进度
  async updateFileProgress(torrentId, fileIndex, progress) {
    try {
      // 首先获取当前种子的文件列表
      const torrent = await prisma.torrentRecord.findFirst({
        where: { id: torrentId },
        include: { files: true }
      });
      
      if (!torrent || !torrent.files || torrent.files.length === 0) {
        console.warn(`未找到种子ID ${torrentId} 的文件记录`);
        return null;
      }
      
      // 找到对应索引的文件
      const fileToUpdate = torrent.files.find(f => f.index === fileIndex);
      if (!fileToUpdate) {
        // 如果没有找到匹配索引的文件，尝试按顺序更新
        if (fileIndex < torrent.files.length) {
          // 按照序号更新文件
          const fileByPosition = torrent.files[fileIndex];
          const updatedFile = await prisma.torrentFile.update({
            where: { id: fileByPosition.id },
            data: { 
              progress: progress,
              index: fileIndex // 更新索引字段
            }
          });
          return updatedFile;
        }
        
        console.warn(`种子ID ${torrentId} 中未找到索引为 ${fileIndex} 的文件`);
        return null;
      }
      
      // 更新文件进度
      const updatedFile = await prisma.torrentFile.update({
        where: { id: fileToUpdate.id },
        data: { 
          progress: progress
        }
      });
      
      return updatedFile;
    } catch (error) {
      console.error(`更新文件进度失败: ${error.message}`);
      return null;
    }
  }
};

export default dbService;  