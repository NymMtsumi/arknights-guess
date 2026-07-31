// WebSocket 代理到 ECS
export default {
  async fetch(request) {
    const url = new URL(request.url);
    // 直接转发到 ECS 的 80 端口（nginx → 3001）
    const target = 'http://106.14.144.232' + url.pathname + url.search;
    return fetch(new Request(target, request));
  }
};
