// Cloudflare Worker - 代理 Socket.IO 到阿里云 ECS
const ORIGIN = 'http://106.14.144.232';

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const targetUrl = ORIGIN + url.pathname + url.search;

    // 转发所有请求到 ECS
    const modified = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined,
      redirect: 'follow',
    });

    return fetch(modified);
  }
};
