// WebSocket 代理到 VPS
export default {
  async fetch(request) {
    const url = new URL(request.url);
    // 直接转发到 VPS 的 3001 端口
    const target = 'http://160.236.110.37:3001' + url.pathname + url.search;
    return fetch(new Request(target, request));
  }
};
