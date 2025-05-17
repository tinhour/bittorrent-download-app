import logger from '../utils/logger.js';

// 默认tracker列表
export const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://tracker.openbittorrent.com:80',
  'udp://tracker.torrent.eu.org:451',
  'udp://tracker.leechers-paradise.org:6969',
  'wss://tracker.openwebtorrent.com' // WebRTC tracker
];

// 全局保存最新获取的tracker列表
let globalTrackers = [...DEFAULT_TRACKERS];

// 获取默认Tracker列表
export function getDefaultTrackers() {
  // 如果已经有全局tracker列表，使用它
  if (globalTrackers.length > 0) {
    logger.info(`使用全局tracker列表 (${globalTrackers.length} 个tracker)`);
    return globalTrackers;
  }
  
  // 否则返回静态列表
  logger.info('使用静态tracker列表');
  return DEFAULT_TRACKERS;
}

// 获取动态Tracker列表 - 从多个来源合并高质量Tracker
export async function getTrackerListFromSources() {
  try {
    // 从多个tracker列表源获取最新列表
    const sources = [      
      'https://ngosang.github.io/trackerslist/trackers_best.txt',
      'https://raw.githubusercontent.com/XIU2/TrackersListCollection/master/best.txt',
      'https://newtrackon.com/api/stable'
    ];
    
    const trackers = new Set(getDefaultTrackers()); // 先添加默认的
    
    // 通过Node.js fetch API获取在线Tracker列表
    const fetchPromises = sources.map(async (url) => {
      try {
        const response = await fetch(url, { timeout: 5000 });
        if (!response.ok) return;
        
        const text = await response.text();
        const list = text.split('\n')
          .map(t => t.trim())
          .filter(t => t && !t.startsWith('#') && (t.startsWith('http') || t.startsWith('udp')));
        
        list.forEach(t => trackers.add(t));
      } catch (err) {
        logger.warn(`获取Tracker列表失败(${url}): ${err.message}`);
      }
    });
    
    await Promise.allSettled(fetchPromises);
    logger.info(`成功获取 ${trackers.size} 个Tracker`);
    return [...trackers];
  } catch (err) {
    logger.error('获取动态Tracker列表失败:', err);
    return getDefaultTrackers(); // 失败时使用默认列表
  }
}

// 辅助函数：处理 infoHash 格式
export function normalizeInfoHash(infoHash) {
  // 检查长度
  if (infoHash.length === 40) {
    // 如果是40位十六进制，符合标准的infoHash表示
    return infoHash.toLowerCase();
  } else if (infoHash.length === 32) {
    // 如果是32位base32编码
    // 这里我们只做简单处理，返回原值
    // 在实际传递给库时让库自己处理
    return infoHash.toLowerCase();
  } else {
    logger.warn(`无效的 infoHash 长度: ${infoHash.length}`);
    return infoHash.toLowerCase(); // 返回原值，让调用点处理错误
  }
}

// 辅助函数：生成增强版磁力链接
export function generateEnhancedMagnet(infoHash, trackers) {
  // 基础磁力链接
  let enhancedMagnet = `magnet:?xt=urn:btih:${infoHash}`;
  
  // 添加trackers
  if (trackers && Array.isArray(trackers) && trackers.length > 0) {
    trackers.forEach(tracker => {
      enhancedMagnet += `&tr=${encodeURIComponent(tracker)}`;
    });
  }
  
  return enhancedMagnet;
}

// 添加支持 BitTorrent v2 协议的功能
export function getEnhancedMagnetURI(magnetURI) {
  if (!magnetURI.includes('magnet:?xt=urn:btih:')) return magnetURI;
  
  // 提取 infoHash
  const infoHashPart = magnetURI.split('magnet:?xt=urn:btih:')[1].split('&')[0];
  const infoHash = normalizeInfoHash(infoHashPart);
  
  // 检查 infoHash 长度，确保是有效的格式
  if (infoHash.length !== 40 && infoHash.length !== 32) {
    logger.warn(`发现无效的 infoHash 长度: ${infoHash.length}，应为40或32`);
    return magnetURI; // 如果无效，返回原始 URI
  }
  
  // 构建增强磁力链接 - 保留原始格式，不要尝试修改 infoHash 本身
  let enhancedMagnet = `magnet:?xt=urn:btih:${infoHash}`;
  
  // 获取高质量 tracker 并添加到链接
  const trackers = getDefaultTrackers();
  trackers.forEach(tracker => {
    enhancedMagnet += `&tr=${encodeURIComponent(tracker)}`;
  });
  
  return enhancedMagnet;
}

// 更新全局tracker列表
export async function updateTrackersList() {
  try {
    const trackers = await getTrackerListFromSources();
    logger.info(`成功获取 ${trackers.length} 个tracker，更新全局列表`);
    
    // 更新全局变量
    globalTrackers = trackers;
    
    return trackers;
  } catch (err) {
    logger.error('更新tracker列表失败:', err);
    throw err;
  }
}

export default {
  DEFAULT_TRACKERS,
  getDefaultTrackers,
  getTrackerListFromSources,
  normalizeInfoHash,
  generateEnhancedMagnet,
  getEnhancedMagnetURI,
  updateTrackersList
}; 