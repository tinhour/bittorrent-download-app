import logger from '../utils/logger.js';
import crypto from 'crypto';
import dgram from 'dgram';

// DHT消息类型
const DHT_MESSAGE_TYPES = {
  QUERY: 'q',
  RESPONSE: 'r',
  ERROR: 'e'
};

// DHT查询类型
const DHT_QUERY_TYPES = {
  PING: 'ping',
  FIND_NODE: 'find_node',
  GET_PEERS: 'get_peers',
  ANNOUNCE_PEER: 'announce_peer'
};

// 已知的DHT引导节点
const BOOTSTRAP_NODES = [
  { host: 'router.bittorrent.com', port: 6881 },
  { host: 'dht.transmissionbt.com', port: 6881 },
  { host: 'router.utorrent.com', port: 6881 },
  { host: 'dht.libtorrent.org', port: 25401 },
  { host: 'dht.aelitis.com', port: 6881 }
];

class DhtEnhancer {
  constructor() {
    this.enabled = false;
    this.socket = null;
    this.nodeId = this.generateNodeId();
    this.discoveredNodes = new Map(); // host:port -> 上次发现时间
    this.pendingRequests = new Map(); // 等待响应的请求
    this.targetInfoHashes = new Set(); // 正在搜索的infoHash
    this.knownPeers = new Map(); // infoHash -> 已知peers集合
    this.clientCallback = null; // WebTorrent客户端回调
  }
  
  // 生成随机NodeID
  generateNodeId() {
    return crypto.randomBytes(20);
  }
  
  // 连接DHT网络
  connect() {
    if (this.enabled) return;
    
    try {
      logger.info('启动DHT增强器...');
      this.socket = dgram.createSocket('udp4');
      
      // 处理接收到的消息
      this.socket.on('message', (message, rinfo) => {
        this.handleMessage(message, rinfo);
      });
      
      // 处理错误
      this.socket.on('error', (err) => {
        logger.error('DHT套接字错误', err);
        this.reconnect();
      });
      
      // 处理关闭
      this.socket.on('close', () => {
        logger.warn('DHT套接字已关闭');
        this.enabled = false;
      });
      
      // 监听本地随机端口
      this.socket.bind(() => {
        logger.info(`DHT增强器监听在端口 ${this.socket.address().port}`);
        this.enabled = true;
        
        // 连接到引导节点
        this.connectToBootstrapNodes();
        
        // 开始定期刷新
        this.startRefreshIntervals();
      });
    } catch (err) {
      logger.error('启动DHT增强器失败', err);
    }
  }
  
  // 连接到引导节点
  connectToBootstrapNodes() {
    BOOTSTRAP_NODES.forEach(node => {
      this.sendFindNodeQuery(node.host, node.port);
    });
  }
  
  // 发送find_node查询
  sendFindNodeQuery(host, port, targetId = null) {
    if (!this.enabled) return;
    
    try {
      // 如果没有指定targetId，则查询一个随机ID
      const target = targetId || crypto.randomBytes(20);
      
      const query = {
        t: crypto.randomBytes(4),
        y: DHT_MESSAGE_TYPES.QUERY,
        q: DHT_QUERY_TYPES.FIND_NODE,
        a: {
          id: this.nodeId,
          target
        }
      };
      
      this.sendMessage(query, host, port);
      
      // 记录请求
      const requestId = query.t.toString('hex');
      this.pendingRequests.set(requestId, {
        host,
        port,
        time: Date.now(),
        type: DHT_QUERY_TYPES.FIND_NODE
      });
      
      // 超时处理
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
        }
      }, 10000); // 10秒超时
    } catch (err) {
      logger.error(`发送find_node查询失败: ${host}:${port}`, err);
    }
  }
  
  // 请求指定infoHash的peers
  announceInfoHash(infoHash) {
    if (!this.enabled || !infoHash) return;
    
    try {
      // 确保infoHash是Buffer
      const targetHash = typeof infoHash === 'string' 
        ? Buffer.from(infoHash, 'hex')
        : infoHash;
      
      // 记录为正在搜索的infoHash
      this.targetInfoHashes.add(targetHash.toString('hex'));
      
      // 向已知节点查询peers
      for (const [nodeAddr] of this.discoveredNodes) {
        const [host, portStr] = nodeAddr.split(':');
        const port = parseInt(portStr, 10);
        
        // 发送get_peers请求
        this.sendGetPeersQuery(host, port, targetHash);
      }
      
      logger.info(`已向 ${this.discoveredNodes.size} 个DHT节点请求infoHash: ${targetHash.toString('hex')}`);
    } catch (err) {
      logger.error(`请求peers失败: ${infoHash}`, err);
    }
  }
  
  // 发送get_peers查询
  sendGetPeersQuery(host, port, infoHash) {
    if (!this.enabled) return;
    
    try {
      const query = {
        t: crypto.randomBytes(4),
        y: DHT_MESSAGE_TYPES.QUERY,
        q: DHT_QUERY_TYPES.GET_PEERS,
        a: {
          id: this.nodeId,
          info_hash: infoHash
        }
      };
      
      this.sendMessage(query, host, port);
      
      // 记录请求
      const requestId = query.t.toString('hex');
      this.pendingRequests.set(requestId, {
        host,
        port,
        time: Date.now(),
        type: DHT_QUERY_TYPES.GET_PEERS,
        infoHash: infoHash.toString('hex')
      });
      
      // 超时处理
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
        }
      }, 10000); // 10秒超时
    } catch (err) {
      logger.error(`发送get_peers查询失败: ${host}:${port}`, err);
    }
  }
  
  // 发送DHT消息
  sendMessage(msg, host, port) {
    if (!this.socket) return;
    
    try {
      const message = Buffer.from(bencode(msg));
      this.socket.send(message, 0, message.length, port, host);
    } catch (err) {
      logger.error(`发送DHT消息失败: ${host}:${port}`, err);
    }
  }
  
  // 处理接收到的DHT消息
  handleMessage(message, rinfo) {
    try {
      const msg = bdecode(message);
      if (!msg) return;
      
      // 记录新发现的节点
      const nodeAddr = `${rinfo.address}:${rinfo.port}`;
      this.discoveredNodes.set(nodeAddr, Date.now());
      
      // 处理不同类型的消息
      if (msg.y === DHT_MESSAGE_TYPES.RESPONSE) {
        this.handleResponse(msg, rinfo);
      } else if (msg.y === DHT_MESSAGE_TYPES.QUERY) {
        this.handleQuery(msg, rinfo);
      } else if (msg.y === DHT_MESSAGE_TYPES.ERROR) {
        this.handleError(msg, rinfo);
      }
    } catch (err) {
      logger.error(`解析DHT消息失败: ${rinfo.address}:${rinfo.port}`, err);
    }
  }
  
  // 处理DHT响应
  handleResponse(msg, rinfo) {
    if (!msg.r) return;
    
    // 获取关联的请求
    const transactionId = msg.t.toString('hex');
    const request = this.pendingRequests.get(transactionId);
    if (!request) return;
    
    this.pendingRequests.delete(transactionId);
    
    // 根据请求类型处理
    if (request.type === DHT_QUERY_TYPES.FIND_NODE) {
      this.processFindNodeResponse(msg.r, rinfo);
    } else if (request.type === DHT_QUERY_TYPES.GET_PEERS) {
      this.processGetPeersResponse(msg.r, request.infoHash, rinfo);
    }
  }
  
  // 处理find_node响应
  processFindNodeResponse(response, rinfo) {
    if (!response.nodes) return;
    
    // 解析紧凑的节点信息
    const nodes = this.parseCompactNodeInfo(response.nodes);
    
    // 连接到新发现的节点
    nodes.forEach(node => {
      if (this.discoveredNodes.size < 1000) { // 限制节点数量
        this.sendFindNodeQuery(node.host, node.port);
      }
    });
    
    logger.debug(`从 ${rinfo.address}:${rinfo.port} 得到 ${nodes.length} 个新节点`);
  }
  
  // 处理get_peers响应
  processGetPeersResponse(response, infoHash, rinfo) {
    // 检查是否找到了peers
    if (response.values) {
      const peers = this.parseCompactPeerInfo(response.values);
      
      if (peers.length > 0) {
        logger.info(`从 ${rinfo.address}:${rinfo.port} 找到 ${peers.length} 个peer，infoHash: ${infoHash}`);
        
        // 记录新的peers
        if (!this.knownPeers.has(infoHash)) {
          this.knownPeers.set(infoHash, new Set());
        }
        
        peers.forEach(peer => {
          this.knownPeers.get(infoHash).add(`${peer.host}:${peer.port}`);
        });
        
        // 通知WebTorrent客户端
        this.notifyClient(infoHash, peers);
      }
    }
    
    // 如果没有peers但有nodes，则继续查询这些节点
    if (response.nodes) {
      const nodes = this.parseCompactNodeInfo(response.nodes);
      
      nodes.forEach(node => {
        if (this.targetInfoHashes.has(infoHash)) {
          this.sendGetPeersQuery(node.host, node.port, Buffer.from(infoHash, 'hex'));
        }
      });
    }
  }
  
  // 处理DHT查询 (接收到的查询)
  handleQuery(msg, rinfo) {
    // 实现最基本的响应，保持DHT网络参与度
    if (!msg.q || !msg.a) return;
    
    if (msg.q === DHT_QUERY_TYPES.PING) {
      this.respondToPing(msg, rinfo);
    } else if (msg.q === DHT_QUERY_TYPES.FIND_NODE) {
      this.respondToFindNode(msg, rinfo);
    } else if (msg.q === DHT_QUERY_TYPES.GET_PEERS) {
      this.respondToGetPeers(msg, rinfo);
    }
  }
  
  // 响应ping查询
  respondToPing(msg, rinfo) {
    const response = {
      t: msg.t,
      y: DHT_MESSAGE_TYPES.RESPONSE,
      r: {
        id: this.nodeId
      }
    };
    
    this.sendMessage(response, rinfo.address, rinfo.port);
  }
  
  // 响应find_node查询
  respondToFindNode(msg, rinfo) {
    // 获取一些随机节点返回
    const nodes = this.getRandomNodesCompact(20);
    
    const response = {
      t: msg.t,
      y: DHT_MESSAGE_TYPES.RESPONSE,
      r: {
        id: this.nodeId,
        nodes
      }
    };
    
    this.sendMessage(response, rinfo.address, rinfo.port);
  }
  
  // 响应get_peers查询
  respondToGetPeers(msg, rinfo) {
    const infoHash = msg.a.info_hash.toString('hex');
    
    // 生成一个唯一token，稍后用于announce_peer
    const token = crypto.createHash('sha1')
      .update(rinfo.address + infoHash)
      .digest()
      .slice(0, 4);
    
    // 检查是否有这个infoHash的peers
    if (this.knownPeers.has(infoHash) && this.knownPeers.get(infoHash).size > 0) {
      // 有peers，回复peers列表
      const peers = Array.from(this.knownPeers.get(infoHash))
        .map(addrStr => {
          const [host, portStr] = addrStr.split(':');
          return { host, port: parseInt(portStr, 10) };
        });
      
      const compactPeers = this.createCompactPeerInfo(peers);
      
      const response = {
        t: msg.t,
        y: DHT_MESSAGE_TYPES.RESPONSE,
        r: {
          id: this.nodeId,
          token,
          values: compactPeers
        }
      };
      
      this.sendMessage(response, rinfo.address, rinfo.port);
    } else {
      // 没有peers，回复接近的节点
      const nodes = this.getRandomNodesCompact(20);
      
      const response = {
        t: msg.t,
        y: DHT_MESSAGE_TYPES.RESPONSE,
        r: {
          id: this.nodeId,
          token,
          nodes
        }
      };
      
      this.sendMessage(response, rinfo.address, rinfo.port);
    }
  }
  
  // 处理DHT错误
  handleError(msg, rinfo) {
    if (msg.e && Array.isArray(msg.e) && msg.e.length >= 2) {
      const [code, message] = msg.e;
      logger.warn(`收到DHT错误: ${code} - ${message} 从 ${rinfo.address}:${rinfo.port}`);
    }
  }
  
  // 解析紧凑格式的节点信息
  parseCompactNodeInfo(compact) {
    if (!Buffer.isBuffer(compact)) return [];
    
    const nodes = [];
    try {
      // 每个节点信息占26字节：20字节nodeId + 4字节IP + 2字节端口
      for (let i = 0; i < compact.length; i += 26) {
        if (i + 26 > compact.length) break;
        
        const nodeId = compact.slice(i, i + 20);
        const ip = compact.readUInt8(i + 20) + '.' + 
                 compact.readUInt8(i + 21) + '.' + 
                 compact.readUInt8(i + 22) + '.' + 
                 compact.readUInt8(i + 23);
        const port = compact.readUInt16BE(i + 24);
        
        if (port > 0 && port < 65536) {
          nodes.push({
            id: nodeId,
            host: ip,
            port
          });
        }
      }
    } catch (err) {
      logger.error('解析紧凑节点信息失败', err);
    }
    
    return nodes;
  }
  
  // 解析紧凑格式的peer信息
  parseCompactPeerInfo(values) {
    if (!Array.isArray(values)) return [];
    
    const peers = [];
    
    values.forEach(compact => {
      if (!Buffer.isBuffer(compact) || compact.length !== 6) return;
      
      try {
        const ip = compact.readUInt8(0) + '.' + 
                 compact.readUInt8(1) + '.' + 
                 compact.readUInt8(2) + '.' + 
                 compact.readUInt8(3);
        const port = compact.readUInt16BE(4);
        
        if (port > 0 && port < 65536) {
          peers.push({ host: ip, port });
        }
      } catch (err) {
        logger.error('解析紧凑peer信息失败', err);
      }
    });
    
    return peers;
  }
  
  // 创建紧凑格式的peer信息
  createCompactPeerInfo(peers) {
    if (!Array.isArray(peers) || peers.length === 0) return [];
    
    return peers.map(peer => {
      try {
        const buf = Buffer.alloc(6);
        const parts = peer.host.split('.');
        
        // 写入IP (4字节)
        for (let i = 0; i < 4; i++) {
          buf.writeUInt8(parseInt(parts[i], 10), i);
        }
        
        // 写入端口 (2字节)
        buf.writeUInt16BE(peer.port, 4);
        
        return buf;
      } catch (err) {
        logger.error(`创建紧凑peer信息失败: ${peer.host}:${peer.port}`, err);
        return null;
      }
    }).filter(Boolean);
  }
  
  // 获取随机节点列表，转换为紧凑格式
  getRandomNodesCompact(count) {
    const nodes = [];
    const nodeAddrs = Array.from(this.discoveredNodes.keys());
    
    for (let i = 0; i < Math.min(count, nodeAddrs.length); i++) {
      const randomIndex = Math.floor(Math.random() * nodeAddrs.length);
      const addrStr = nodeAddrs[randomIndex];
      const [host, portStr] = addrStr.split(':');
      const port = parseInt(portStr, 10);
      
      nodeAddrs.splice(randomIndex, 1); // 防止重复
      
      nodes.push({ host, port });
    }
    
    // 转换为紧凑格式
    let compact = Buffer.alloc(nodes.length * 26);
    
    for (let i = 0; i < nodes.length; i++) {
      // 为每个节点生成一个随机ID
      const nodeId = crypto.randomBytes(20);
      nodeId.copy(compact, i * 26);
      
      // 写入IP
      const parts = nodes[i].host.split('.');
      for (let j = 0; j < 4; j++) {
        compact.writeUInt8(parseInt(parts[j], 10), i * 26 + 20 + j);
      }
      
      // 写入端口
      compact.writeUInt16BE(nodes[i].port, i * 26 + 24);
    }
    
    return compact;
  }
  
  // 设置客户端回调，用于通知发现的peers
  setClientCallback(callback) {
    this.clientCallback = callback;
  }
  
  // 通知客户端发现的peers
  notifyClient(infoHash, peers) {
    if (this.clientCallback && typeof this.clientCallback === 'function') {
      this.clientCallback(infoHash, peers);
    }
  }
  
  // 启动定期刷新间隔
  startRefreshIntervals() {
    // 每15分钟刷新与随机节点的连接
    setInterval(() => {
      this.refreshConnections();
    }, 15 * 60 * 1000);
    
    // 每小时清理旧节点
    setInterval(() => {
      this.cleanupOldNodes();
    }, 60 * 60 * 1000);
  }
  
  // 刷新与DHT节点的连接
  refreshConnections() {
    if (!this.enabled) return;
    
    logger.info('刷新DHT节点连接...');
    
    // 重新连接到一些随机节点
    const nodeAddrs = Array.from(this.discoveredNodes.keys());
    const refreshCount = Math.min(20, nodeAddrs.length);
    
    for (let i = 0; i < refreshCount; i++) {
      const randomIndex = Math.floor(Math.random() * nodeAddrs.length);
      const addrStr = nodeAddrs[randomIndex];
      const [host, portStr] = addrStr.split(':');
      const port = parseInt(portStr, 10);
      
      this.sendFindNodeQuery(host, port);
    }
    
    // 如果节点太少，重新连接引导节点
    if (this.discoveredNodes.size < 20) {
      this.connectToBootstrapNodes();
    }
  }
  
  // 清理长时间未活动的旧节点
  cleanupOldNodes() {
    if (!this.enabled) return;
    
    const now = Date.now();
    let count = 0;
    
    for (const [addr, lastSeen] of this.discoveredNodes.entries()) {
      if (now - lastSeen > 3 * 60 * 60 * 1000) { // 3小时未活动
        this.discoveredNodes.delete(addr);
        count++;
      }
    }
    
    if (count > 0) {
      logger.info(`清理了 ${count} 个不活跃DHT节点，剩余 ${this.discoveredNodes.size} 个`);
    }
  }
  
  // 重新连接DHT网络
  reconnect() {
    if (this.socket) {
      try {
        this.socket.close();
      } catch (err) {
        logger.error('关闭DHT套接字失败', err);
      }
    }
    
    this.socket = null;
    this.enabled = false;
    
    logger.info('正在重新连接DHT网络...');
    setTimeout(() => {
      this.connect();
    }, 5000); // 5秒后重试
  }
  
  // 停止DHT增强器
  stop() {
    if (!this.enabled) return;
    
    logger.info('停止DHT增强器...');
    
    this.enabled = false;
    
    if (this.socket) {
      try {
        this.socket.close();
      } catch (err) {
        logger.error('关闭DHT套接字失败', err);
      }
    }
    
    this.socket = null;
    this.discoveredNodes.clear();
    this.pendingRequests.clear();
    this.targetInfoHashes.clear();
    this.knownPeers.clear();
  }
  
  // 获取当前状态信息
  getStatus() {
    return {
      enabled: this.enabled,
      discoveredNodes: this.discoveredNodes.size,
      activeTorrents: this.targetInfoHashes.size,
      pendingRequests: this.pendingRequests.size,
      knownPeers: Array.from(this.knownPeers.entries()).map(([infoHash, peers]) => ({
        infoHash,
        peerCount: peers.size
      }))
    };
  }
}

// 简单的bencode编码实现
function bencode(data) {
  if (Buffer.isBuffer(data)) {
    return Buffer.concat([Buffer.from(`${data.length}:`), data]);
  } else if (typeof data === 'string') {
    return `${data.length}:${data}`;
  } else if (typeof data === 'number') {
    return `i${data}e`;
  } else if (Array.isArray(data)) {
    let result = 'l';
    for (const item of data) {
      result += bencode(item);
    }
    result += 'e';
    return result;
  } else if (data && typeof data === 'object') {
    const keys = Object.keys(data).sort();
    let result = 'd';
    for (const key of keys) {
      result += bencode(key);
      result += bencode(data[key]);
    }
    result += 'e';
    return result;
  }
  return '';
}

// 简单的bencode解码实现
function bdecode(data, start = 0) {
  if (!Buffer.isBuffer(data)) {
    if (typeof data === 'string') {
      data = Buffer.from(data);
    } else {
      return null;
    }
  }
  
  // 简化实现，实际应用中应使用完整的bdecode库
  try {
    // 这里返回一个简单的占位解析结果
    // 实际应用中应替换为完整的解析
    return {
      y: data.toString('utf8', start, start + 1),
      t: data.slice(start + 1, start + 5),
      r: {},
      a: {
        id: crypto.randomBytes(20),
        info_hash: crypto.randomBytes(20)
      }
    };
  } catch (err) {
    logger.error('bdecode失败', err);
    return null;
  }
}

export default new DhtEnhancer(); 