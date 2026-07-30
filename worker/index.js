// Cloudflare Worker - WebSocket 代理到阿里云
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade');

    if (upgrade === 'websocket') {
      // 代理 WebSocket 到阿里云
      const target = new URL(url.pathname + url.search, 'http://106.14.144.232:3001');
      return fetch(target, request);
    }

    return new Response('理一把 WebSocket 代理', { status: 200 });
  }
};
