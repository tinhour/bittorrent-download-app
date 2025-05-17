import os from 'os';
import config from '../config/index.js';
import logger from '../utils/logger.js';

class SystemMonitor {
  constructor() {
    this.stats = {
      startTime: new Date(),
      uptime: 0,
      torrentsProcessed: 0,
      activeConnections: 0,
      peakConnections: 0,
      totalDataDownloaded: 0,
      failedRequests: 0,
      errors: [],
      lastCheck: null,
      system: {
        cpuUsage: 0,
        memoryUsage: 0,
        freeMemory: 0,
        totalMemory: 0,
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length
      },
      network: {
        downloadSpeed: 0,
        uploadSpeed: 0,
        peers: 0
      }
    };
    
    // 限制错误日志大小
    this.maxErrorsStored = 20;
    
    // 开始监控
    this.startMonitoring();
  }
  
  // 更新CPU和内存使用情况
  updateSystemStats() {
    try {
      // 获取CPU使用信息
      const cpus = os.cpus();
      let totalIdle = 0;
      let totalTick = 0;
      
      cpus.forEach(cpu => {
        for (const type in cpu.times) {
          totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
      });
      
      const idlePercent = totalIdle / totalTick;
      this.stats.system.cpuUsage = parseFloat((100 - idlePercent * 100).toFixed(1));
      
      // 获取内存使用情况
      const totalMemory = os.totalmem();
      const freeMemory = os.freemem();
      const usedMemory = totalMemory - freeMemory;
      
      this.stats.system.totalMemory = totalMemory;
      this.stats.system.freeMemory = freeMemory;
      this.stats.system.memoryUsage = parseFloat((usedMemory / totalMemory * 100).toFixed(1));
      
      this.stats.uptime = Math.floor((new Date() - this.stats.startTime) / 1000);
      this.stats.lastCheck = new Date();
    } catch (err) {
      logger.error('更新系统统计信息失败', err);
    }
  }
  
  // 向WebTorrent客户端注册事件，获取下载和上传速度
  registerClient(client) {
    if (!client) return;
    
    logger.info('向WebTorrent客户端注册监控事件');
    
    // 定期更新客户端状态
    setInterval(() => {
      try {
        if (client) {
          this.stats.network.downloadSpeed = client.downloadSpeed;
          this.stats.network.uploadSpeed = client.uploadSpeed;
          this.stats.network.peers = client.torrents.reduce((sum, torrent) => sum + torrent.numPeers, 0);
        }
      } catch (err) {
        logger.error('更新WebTorrent状态失败', err);
      }
    }, 2000);
  }
  
  // 增加处理的种子计数
  incrementTorrentsProcessed() {
    this.stats.torrentsProcessed++;
  }
  
  // 更新活动连接数
  updateConnections(count) {
    this.stats.activeConnections = count;
    if (count > this.stats.peakConnections) {
      this.stats.peakConnections = count;
    }
  }
  
  // 添加下载的数据
  addDownloadedData(bytes) {
    this.stats.totalDataDownloaded += bytes;
  }
  
  // 增加失败请求计数
  incrementFailedRequests() {
    this.stats.failedRequests++;
  }
  
  // 记录错误
  logError(error) {
    // 创建简化的错误对象
    const errorObj = {
      message: error.message || String(error),
      time: new Date(),
      stack: error.stack
    };
    
    // 添加到错误列表前面
    this.stats.errors.unshift(errorObj);
    
    // 限制存储的错误数量
    if (this.stats.errors.length > this.maxErrorsStored) {
      this.stats.errors.pop();
    }
  }
  
  // 开始监控
  startMonitoring() {
    // 立即更新一次
    this.updateSystemStats();
    
    // 每分钟更新系统统计信息
    setInterval(() => {
      this.updateSystemStats();
    }, config.HEALTH_CHECK_INTERVAL);
    
    logger.info('系统监控服务已启动');
  }
  
  // 获取系统状态信息
  getStatus() {
    // 复制一份状态信息避免引用被修改
    return JSON.parse(JSON.stringify(this.stats));
  }
  
  // 获取关键健康指标
  getHealthMetrics() {
    return {
      status: this.getHealthStatus(),
      uptime: this.stats.uptime,
      cpu: this.stats.system.cpuUsage,
      memory: this.stats.system.memoryUsage,
      peers: this.stats.network.peers,
      downloadSpeed: this.formatSpeed(this.stats.network.downloadSpeed),
      errors: this.stats.errors.length,
      lastChecked: this.stats.lastCheck
    };
  }
  
  // 确定系统健康状态
  getHealthStatus() {
    const cpu = this.stats.system.cpuUsage;
    const memory = this.stats.system.memoryUsage;
    const errorCount = this.stats.errors.length;
    
    if (cpu > 90 || memory > 90 || errorCount > 10) {
      return 'critical';
    }
    
    if (cpu > 75 || memory > 75 || errorCount > 5) {
      return 'warning';
    }
    
    return 'healthy';
  }
  
  // 格式化速度显示
  formatSpeed(bytesPerSecond) {
    if (bytesPerSecond < 1024) {
      return `${bytesPerSecond} B/s`;
    } else if (bytesPerSecond < 1024 * 1024) {
      return `${(bytesPerSecond / 1024).toFixed(2)} KB/s`;
    } else {
      return `${(bytesPerSecond / 1024 / 1024).toFixed(2)} MB/s`;
    }
  }
}

export default new SystemMonitor(); 