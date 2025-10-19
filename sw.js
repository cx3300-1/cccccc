// sw.js

// --- 1. 基本设置 ---

// 缓存名称，当应用文件更新时，我们会修改这个名字来触发缓存更新
const CACHE_NAME = 'ephone-cache-v1'; 
// 数据库名称
const DB_NAME = 'ephone-offline-db';
const DB_VERSION = 1;
// 离线消息存储的“表名”
const OFFLINE_STORE_NAME = 'offlineMessages';

let db; // 用于持有数据库连接

// --- 2. 核心事件监听 ---

/**
 * 当浏览器安装 Service Worker 时触发
 * 通常用于缓存应用的核心静态资源（App Shell）
 */
self.addEventListener('install', event => {
    console.log('Service Worker: Install 事件触发');
    // self.skipWaiting() 会强制新的 Service Worker 立即激活，跳过等待阶段
    event.waitUntil(self.skipWaiting());
});

/**
 * 当 Service Worker 被激活时触发
 * 通常用于清理旧版本的缓存
 */
self.addEventListener('activate', event => {
    console.log('Service Worker: Activate 事件触发');
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    // 如果缓存名不是我们当前定义的这个，就说明是旧缓存，需要删除
                    if (cacheName !== CACHE_NAME) {
                        console.log('Service Worker: 正在清理旧缓存:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim()) // 确保新的 Service Worker 立即控制所有打开的页面
    );
});

/**
 * 【核心功能】当收到推送通知时触发
 */
self.addEventListener('push', event => {
    console.log('Service Worker: Push 事件触发');

    if (!event.data) {
        console.warn('Push 事件没有接收到任何数据。');
        return;
    }

    try {
        const data = event.data.json(); // 解析推送过来的JSON数据
        
        const title = data.title || 'EPhone 有新消息';
        const options = {
            body: data.body || '你收到了一条新消息。',
            icon: data.icon || 'https://s3plus.meituan.net/opapisdk/op_ticket_885190757_1758510900942_qdqqd_djw0z2.jpeg', // 默认图标
            badge: data.badge || 'https://s3plus.meituan.net/opapisdk/op_ticket_885190757_1758510900942_qdqqd_djw0z2.jpeg', // 安卓设备上的小图标
            tag: data.tag || 'ephone-notification', // 使用标签可以防止同一类型的通知刷屏
            data: data.data // 将聊天ID等附加数据存起来，方便点击时使用
        };

        // 存储离线消息
        const storePromise = storeOfflineMessage(options.data.chatId, options.data.message);
        
        // 显示通知
        const showNotificationPromise = self.registration.showNotification(title, options);
        
        event.waitUntil(Promise.all([storePromise, showNotificationPromise]));

    } catch (e) {
        console.error('解析推送数据失败:', e);
        // 即使解析失败，也显示一个通用通知
        event.waitUntil(
            self.registration.showNotification('EPhone', {
                body: '你收到了一条新消息。',
                icon: 'https://s3plus.meituan.net/opapisdk/op_ticket_885190757_1758510900942_qdqqd_djw0z2.jpeg'
            })
        );
    }
});


/**
 * 【核心功能】当用户点击通知时触发
 */
self.addEventListener('notificationclick', event => {
    console.log('Service Worker: NotificationClick 事件触发');
    
    event.notification.close(); // 首先关闭通知
    
    const urlToOpen = new URL('/', self.location.origin).href;
    const notificationData = event.notification.data;

    event.waitUntil(
        clients.matchAll({
            type: 'window',
            includeUncontrolled: true
        }).then(windowClients => {
            // 检查是否已经有一个窗口打开了我们的应用
            let matchingClient = null;
            for (let i = 0; i < windowClients.length; i++) {
                const client = windowClients[i];
                if (client.url === urlToOpen) {
                    matchingClient = client;
                    break;
                }
            }

            if (matchingClient) {
                // 如果找到了，就切换到那个窗口
                matchingClient.focus();
                // 并通过 postMessage 把通知数据（包含聊天ID）发给它
                if (notificationData) {
                    matchingClient.postMessage({ type: 'NOTIFICATION_CLICK', data: notificationData });
                }
            } else {
                // 如果没找到，就打开一个新窗口
                clients.openWindow(urlToOpen).then(newClient => {
                    // 等待新窗口加载完成后再发送消息
                    // 这是一个小技巧，确保消息不会在页面准备好之前就发送
                    const channel = new MessageChannel();
                    newClient.postMessage({ type: 'READY_FOR_MESSAGE' }, [channel.port2]);
                    channel.port1.onmessage = () => {
                         if (notificationData) {
                            newClient.postMessage({ type: 'NOTIFICATION_CLICK', data: notificationData });
                         }
                    };
                });
            }
        })
    );
});

/**
 * 【核心功能】监听来自主页面的消息
 */
self.addEventListener('message', event => {
    console.log('Service Worker: Message 事件触发, 收到命令:', event.data.command);
    
    if (event.data && event.data.command === 'REQUEST_OFFLINE_MESSAGES') {
        // 当主页面请求离线消息时
        event.waitUntil(
            getAndClearOfflineMessages().then(messages => {
                // 将消息发送回主页面
                if (messages.length > 0) {
                     event.source.postMessage({ type: 'OFFLINE_MESSAGES', messages: messages });
                }
            })
        );
    }
    // (为了兼容新打开的窗口)
    if (event.data && event.data.type === 'PAGE_IS_READY') {
        event.ports[0].postMessage({ status: 'OK' });
    }
});


// --- 3. IndexedDB 辅助函数 ---

/**
 * 打开或创建 IndexedDB 数据库
 */
function openDb() {
    if (db) return Promise.resolve(db);
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = event => {
            const dbInstance = event.target.result;
            if (!dbInstance.objectStoreNames.contains(OFFLINE_STORE_NAME)) {
                dbInstance.createObjectStore(OFFLINE_STORE_NAME, { autoIncrement: true });
            }
        };
        request.onsuccess = event => {
            db = event.target.result;
            resolve(db);
        };
        request.onerror = event => {
            reject('IndexedDB error: ' + event.target.errorCode);
        };
    });
}

/**
 * 将单条离线消息存入数据库
 * @param {string} chatId - 消息所属的聊天ID
 * @param {object} message - 完整的消息对象
 */
async function storeOfflineMessage(chatId, message) {
    if (!chatId || !message) return;
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([OFFLINE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(OFFLINE_STORE_NAME);
        const request = store.add({ chatId, message });
        request.onsuccess = resolve;
        request.onerror = reject;
    });
}

/**
 * 从数据库中获取所有离线消息，然后清空数据库
 * @returns {Promise<Array>} - 返回一个包含所有离线消息的数组
 */
async function getAndClearOfflineMessages() {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([OFFLINE_STORE_NAME], 'readwrite');
        const store = transaction.objectStore(OFFLINE_STORE_NAME);
        const getAllRequest = store.getAll();
        
        getAllRequest.onsuccess = () => {
            const messages = getAllRequest.result;
            const clearRequest = store.clear();
            clearRequest.onsuccess = () => resolve(messages);
            clearRequest.onerror = reject;
        };
        getAllRequest.onerror = reject;
    });
}
