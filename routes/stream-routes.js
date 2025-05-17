import express from 'express';
import path from 'path';
import fs from 'fs';
import mime from 'mime';
import logger from '../utils/logger.js';
import config from '../config/index.js';
import webtorrentClient from '../services/webtorrent-client.js';
import systemMonitor from '../utils/system-monitor.js';
import dbService from '../services/db-service.js';
import diskManager from '../services/disk-manager.js';

const router = express.Router();
const client = webtorrentClient.client;
const downloadPath = webtorrentClient.downloadPath;

// 流媒体服务端点 - 按文件索引
router.get('/stream/:infoHash/:fileIndex', (req, res) => {
  try {
    const { infoHash, fileIndex } = req.params;
    const index = parseInt(fileIndex, 10);
    
    if (!infoHash || isNaN(index)) {
      return res.status(400).json({
        success: false,
        error: '无效的请求参数'
      });
    }
    
    logger.info(`收到流媒体请求: ${infoHash}, 文件索引: ${index}`);
    
    // 尝试从WebTorrent客户端获取文件
    const torrent = client.get(infoHash);
    if (torrent && torrent.files && torrent.files[index]) {
      const file = torrent.files[index];
      logger.info(`提供WebTorrent文件: ${file.name} (${(file.length / 1024 / 1024).toFixed(2)} MB)`);
      
      // 支持Range请求
      const range = req.headers.range;
      const fileSize = file.length;

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;
        
        logger.debug(`Range请求: ${start}-${end}/${fileSize}`);
        
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': mime.getType(file.name) || 'application/octet-stream'
        });
        
        // WebTorrent的文件对象可以创建流
        const fileStream = file.createReadStream({ start, end });
        fileStream.pipe(res);
        
        // 监控数据传输
        let bytesTransferred = 0;
        fileStream.on('data', (chunk) => {
          bytesTransferred += chunk.length;
        });
        
        fileStream.on('end', () => {
          logger.debug(`流媒体传输完成: ${(bytesTransferred / 1024 / 1024).toFixed(2)} MB`);
          systemMonitor.addDownloadedData(bytesTransferred);
        });
        
        fileStream.on('error', (err) => {
          logger.error(`流媒体传输错误: ${err.message}`);
          if (!res.headersSent) {
            res.status(500).send('读取文件流时出错');
          }
        });
      } else {
        // 非范围请求，提供整个文件
        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': mime.getType(file.name) || 'application/octet-stream'
        });
        
        const fileStream = file.createReadStream();
        fileStream.pipe(res);
      }
      
      return;
    }
    
    // 如果找不到WebTorrent客户端中的文件，直接返回错误
    logger.warn(`找不到请求的文件: ${infoHash}, 索引: ${index}`);
    return res.status(404).json({
      success: false,
      error: '找不到请求的文件'
    });
  } catch (err) {
    logger.error(`流媒体请求处理失败: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: '处理流媒体请求时出错'
    });
  }
});

// 文件下载端点
router.get('/download/:infoHash/:fileIndex', (req, res) => {
  try {
    const { infoHash, fileIndex } = req.params;
    const index = parseInt(fileIndex, 10);
    
    if (!infoHash || isNaN(index)) {
      return res.status(400).json({
        success: false,
        error: '无效的请求参数'
      });
    }
    
    logger.info(`收到文件下载请求: ${infoHash}, 文件索引: ${index}`);
    
    // 尝试从WebTorrent客户端获取文件
    const torrent = client.get(infoHash);
    if (torrent && torrent.files && torrent.files[index]) {
      const file = torrent.files[index];
      logger.info(`提供WebTorrent下载: ${file.name} (${(file.length / 1024 / 1024).toFixed(2)} MB)`);
      
      // 设置文件下载头
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', file.length);
      
      // 创建文件流并传输
      const fileStream = file.createReadStream();
      fileStream.pipe(res);
      
      // 监控下载进度
      let bytesTransferred = 0;
      fileStream.on('data', (chunk) => {
        bytesTransferred += chunk.length;
      });
      
      fileStream.on('end', () => {
        logger.info(`文件下载完成: ${(bytesTransferred / 1024 / 1024).toFixed(2)} MB`);
        systemMonitor.addDownloadedData(bytesTransferred);
      });
      
      fileStream.on('error', (err) => {
        logger.error(`文件下载错误: ${err.message}`);
        if (!res.headersSent) {
          res.status(500).send('读取文件时出错');
        }
      });
      
      return;
    }
    
    // 如果找不到WebTorrent客户端中的文件，直接返回错误
    logger.warn(`找不到请求的下载文件: ${infoHash}, 索引: ${index}`);
    
    // 尝试从数据库查找种子信息，检查文件是否存在于磁盘上
    dbService.getTorrentByInfoHash(infoHash)
      .then(async (torrentRecord) => {
        if (!torrentRecord) {
          logger.warn(`找不到种子记录: ${infoHash}`);
          return res.status(404).json({ 
            error: '找不到种子记录',
            code: 'TORRENT_NOT_FOUND'
          });
        }
        
        logger.info(`找到种子记录: ${torrentRecord.name}`);
        
        // 查找匹配的文件记录
        if (!torrentRecord.files || torrentRecord.files.length === 0) {
          logger.warn(`种子记录中没有文件: ${infoHash}`);
          return res.status(404).json({ 
            error: '种子中没有文件记录',
            code: 'FILES_NOT_FOUND'
          });
        }
        
        if (index >= torrentRecord.files.length) {
          logger.warn(`文件索引超出范围: ${index}, 最大索引: ${torrentRecord.files.length - 1}`);
          return res.status(404).json({ 
            error: '文件索引超出范围',
            code: 'INVALID_FILE_INDEX'
          });
        }
        
        const fileRecord = torrentRecord.files[index];
        if (!fileRecord) {
          logger.warn(`找不到索引为 ${index} 的文件记录`);
          return res.status(404).json({ 
            error: '找不到请求的文件记录',
            code: 'FILE_NOT_FOUND'
          });
        }
        
        logger.info(`找到文件记录，但种子不活动: ${fileRecord.name}`);
        
        // 首先尝试从数据库获取种子名称
        const torrentName = torrentRecord.name || infoHash;
        
        // 检查文件是否在磁盘上 - 依次检查种子名称目录和infoHash目录
        const infoHashDirectory = path.join(config.DOWNLOAD_PATH, infoHash);
        const torrentNameDirectory = path.join(config.DOWNLOAD_PATH, torrentName);
        
        // 可能的文件路径
        const infoHashFilePath = path.join(infoHashDirectory, fileRecord.name);
        const torrentNameFilePath = path.join(torrentNameDirectory, fileRecord.name);
        
        logger.debug(`检查种子名称目录文件路径: ${torrentNameFilePath}`);
        logger.debug(`检查infoHash目录文件路径: ${infoHashFilePath}`);
        
        // 尝试获取种子名称目录或infoHash目录中的文件
        try {
          let filePath = '';
          let fileExists = false;
          
          // 首先尝试种子名称目录
          try {
            await fs.promises.access(torrentNameFilePath, fs.constants.R_OK);
            filePath = torrentNameFilePath;
            fileExists = true;
            logger.info(`文件存在于种子名称目录: ${filePath}`);
          } catch (e) {
            logger.info(`文件不存在于种子名称目录，尝试infoHash目录`);
            
            // 如果种子名称目录中没有，尝试infoHash目录
            try {
              await fs.promises.access(infoHashFilePath, fs.constants.R_OK);
              filePath = infoHashFilePath;
              fileExists = true;
              logger.info(`文件存在于infoHash目录: ${filePath}`);
            } catch (e2) {
              // 两个目录都没有找到
              logger.warn(`文件在两个目录中都不存在: ${fileRecord.name}`);
            }
          }
          
          if (!fileExists) {
            return res.status(404).json({ 
              error: '文件不存在或已被删除',
              code: 'FILE_NOT_FOUND',
              checkedPaths: [torrentNameFilePath, infoHashFilePath]
            });
          }
          
          const stats = await fs.promises.stat(filePath);
          const fileSize = stats.size;
          logger.info(`找到磁盘文件: ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
          
          // 设置文件下载头
          res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileRecord.name)}"`);
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Content-Length', fileSize);
          
          // 创建文件流并传输
          const fileStream = fs.createReadStream(filePath);
          fileStream.pipe(res);
          
          // 监控下载进度
          let bytesTransferred = 0;
          fileStream.on('data', (chunk) => {
            bytesTransferred += chunk.length;
          });
          
          fileStream.on('end', () => {
            logger.info(`文件下载完成: ${(bytesTransferred / 1024 / 1024).toFixed(2)} MB`);
            systemMonitor.addDownloadedData(bytesTransferred);
          });
          
          fileStream.on('error', (err) => {
            logger.error(`文件下载错误: ${err.message}`);
            if (!res.headersSent) {
              res.status(500).send('读取文件时出错');
            }
          });
        } catch (err) {
          logger.error(`处理文件下载请求失败: ${err.message}`);
          return res.status(500).json({ 
            error: '处理文件下载请求失败',
            code: 'SERVER_ERROR'
          });
        }
      })
      .catch(err => {
        logger.error(`数据库查询失败: ${err.message}`);
        return res.status(500).json({
          success: false,
          error: '服务器错误'
        });
      });
  } catch (err) {
    logger.error(`文件下载请求处理失败: ${err.message}`);
    return res.status(500).json({
      success: false,
      error: '处理下载请求时出错'
    });
  }
});

// 根据文件名流式传输
router.get('/api/stream/:infoHash/:fileName', (req, res) => {
  try {
    const { infoHash, fileName } = req.params;
    const decodedFileName = decodeURIComponent(fileName);
    
    // 添加参数验证
    if (!infoHash || !fileName) {
      logger.error('流媒体请求参数不完整');
      return res.status(400).json({ 
        error: '请求参数不完整', 
        code: 'INVALID_PARAMS' 
      });
    }
    
    logger.info(`收到按文件名的流媒体请求: ${infoHash}, 文件名: ${decodedFileName}`);
    
    // 尝试从WebTorrent客户端获取种子
    const torrent = client.get(infoHash);
    if (torrent && torrent.files) {
      // 查找匹配的文件
      const file = torrent.files.find(f => f.name === decodedFileName);
      
      if (file) {
        logger.info(`找到文件: ${file.name} (${(file.length / 1024 / 1024).toFixed(2)} MB), 进度: ${Math.round(file.progress * 100)}%`);
        
        // 支持Range请求
        const range = req.headers.range;
        const fileSize = file.length;
        
        if (range) {
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
          const chunkSize = end - start + 1;
          
          logger.debug(`Range请求: ${start}-${end}/${fileSize}`);
          
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': mime.getType(file.name) || 'application/octet-stream'
          });
          
          // WebTorrent的文件对象可以创建流
          const fileStream = file.createReadStream({ start, end });
          fileStream.pipe(res);
          
          // 监控数据传输
          let bytesTransferred = 0;
          fileStream.on('data', (chunk) => {
            bytesTransferred += chunk.length;
          });
          
          fileStream.on('end', () => {
            logger.debug(`流媒体传输完成: ${(bytesTransferred / 1024 / 1024).toFixed(2)} MB`);
            systemMonitor.addDownloadedData(bytesTransferred);
          });
          
          fileStream.on('error', (err) => {
            logger.error(`流媒体传输错误: ${err.message}`);
            if (!res.headersSent) {
              res.status(500).send('读取文件流时出错');
            }
          });
        } else {
          // 非范围请求，提供整个文件
          res.writeHead(200, {
            'Content-Length': fileSize,
            'Content-Type': mime.getType(file.name) || 'application/octet-stream'
          });
          
          const fileStream = file.createReadStream();
          fileStream.pipe(res);
        }
        
        return;
      }
    }
    
    // 如果在活动种子中找不到文件，尝试从数据库查找种子记录
    dbService.getTorrentByInfoHash(infoHash)
      .then(async (torrentRecord) => {
        if (!torrentRecord) {
          logger.warn(`找不到种子记录: ${infoHash}`);
          return res.status(404).json({ 
            error: '找不到种子记录', 
            code: 'TORRENT_NOT_FOUND'
          });
        }
        
        logger.info(`找到种子记录: ${torrentRecord.name}`);
        
        // 查找匹配的文件记录
        if (!torrentRecord.files || torrentRecord.files.length === 0) {
          logger.warn(`种子记录中没有文件: ${infoHash}`);
          return res.status(404).json({ 
            error: '种子中没有文件记录',
            code: 'FILES_NOT_FOUND'
          });
        }
        
        const fileRecord = torrentRecord.files.find(f => f.name === decodedFileName);
        if (!fileRecord) {
          logger.warn(`找不到文件记录: ${decodedFileName}`);
          return res.status(404).json({ 
            error: '找不到请求的文件记录',
            code: 'FILE_NOT_FOUND'
          });
        }
        
        logger.info(`找到文件记录，但种子不活动: ${decodedFileName}`);
        
        // 首先尝试从数据库获取种子名称
        const torrentName = torrentRecord.name || infoHash;
        
        // 检查文件是否在磁盘上 - 依次检查种子名称目录和infoHash目录
        const infoHashDirectory = path.join(config.DOWNLOAD_PATH, infoHash);
        const torrentNameDirectory = path.join(config.DOWNLOAD_PATH, torrentName);
        
        // 可能的文件路径
        const infoHashFilePath = path.join(infoHashDirectory, decodedFileName);
        const torrentNameFilePath = path.join(torrentNameDirectory, decodedFileName);
        
        logger.debug(`检查种子名称目录文件路径: ${torrentNameFilePath}`);
        logger.debug(`检查infoHash目录文件路径: ${infoHashFilePath}`);
        
        // 首先检查种子名称目录中的文件
        try {
          // 尝试获取种子名称目录中的文件
          let filePath = '';
          let fileExists = false;
          
          // 首先尝试种子名称目录
          try {
            await fs.promises.access(torrentNameFilePath, fs.constants.R_OK);
            filePath = torrentNameFilePath;
            fileExists = true;
            logger.info(`文件存在于种子名称目录: ${filePath}`);
          } catch (e) {
            logger.info(`文件不存在于种子名称目录，尝试infoHash目录`);
            
            // 如果种子名称目录中没有，尝试infoHash目录
            try {
              await fs.promises.access(infoHashFilePath, fs.constants.R_OK);
              filePath = infoHashFilePath;
              fileExists = true;
              logger.info(`文件存在于infoHash目录: ${filePath}`);
            } catch (e2) {
              // 两个目录都没有找到
              logger.warn(`文件在两个目录中都不存在: ${decodedFileName}`);
            }
          }
          
          if (!fileExists) {
            return res.status(404).json({ 
              error: '文件不存在或已被删除',
              code: 'FILE_NOT_FOUND',
              checkedPaths: [torrentNameFilePath, infoHashFilePath]
            });
          }
          
          const stats = await fs.promises.stat(filePath);
          const fileSize = stats.size;
          logger.info(`找到磁盘文件: ${filePath} (${(fileSize / 1024 / 1024).toFixed(2)} MB)`);
          
          // 支持Range请求
          const range = req.headers.range;
          
          if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = end - start + 1;
            
            logger.debug(`Range请求: ${start}-${end}/${fileSize}`);
            
            res.writeHead(206, {
              'Content-Range': `bytes ${start}-${end}/${fileSize}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': chunkSize,
              'Content-Type': mime.getType(decodedFileName) || 'application/octet-stream'
            });
            
            const fileStream = fs.createReadStream(filePath, { start, end });
            fileStream.pipe(res);
            
            fileStream.on('error', (err) => {
              logger.error(`文件流错误: ${err.message}`);
              if (!res.headersSent) {
                res.status(500).json({ error: '文件流错误' });
              }
            });
          } else {
            // 非范围请求，提供整个文件
            res.writeHead(200, {
              'Content-Length': fileSize,
              'Content-Type': mime.getType(decodedFileName) || 'application/octet-stream'
            });
            
            const fileStream = fs.createReadStream(filePath);
            fileStream.pipe(res);
            
            fileStream.on('error', (err) => {
              logger.error(`文件流错误: ${err.message}`);
              if (!res.headersSent) {
                res.status(500).json({ error: '文件流错误' });
              }
            });
          }
        } catch (err) {
          // 文件不存在
          logger.error(`无法访问文件: ${err.message}`);
          
          return res.status(404).json({ 
            error: '文件不存在或已被删除',
            code: 'FILE_DELETED'
          });
        }
      })
      .catch(err => {
        logger.error(`处理流媒体请求错误: ${err.message}`);
        return res.status(500).json({ 
          error: '处理请求时出错',
          code: 'SERVER_ERROR'
        });
      });
  } catch (err) {
    logger.error(`流媒体请求处理失败: ${err.message}`);
    return res.status(500).json({
      error: '处理流媒体请求时出错',
      code: 'UNKNOWN_ERROR'
    });
  }
});

export default router; 