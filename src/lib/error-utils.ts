/**
 * `catch (err)` 的值在 TS 里是 `unknown`（tsconfig 的 `useUnknownInCatchVariables`）。
 * 全项目有几十个地方要取它的文案 —— 统一在这里收窄，避免为了读 `.message`
 * 把变量标成 `any`（那正是 2026-10-17 清 lint 债里 no-explicit-any 报的一类）。
 *
 * ⚠️ 为什么不用 `err instanceof Error ? err.message : ...` 就地写：
 *    那样每个调用点都要重复一次，且「非 Error 但带 message 的对象」会被漏掉。
 *    apiCall 抛的都是 Error，但 socket 回调 / 旧代码里也可能抛字符串或裸对象，
 *    这个 helper 把两种都兜住，语义与原 `err.message || fallback` 保持一致。
 */

/** 从任意 catch 值里取出可展示的错误文案；取不到时返回 fallback。 */
export function errorMessage(err: unknown, fallback = ''): string {
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === 'string') return err || fallback;
  if (err !== null && typeof err === 'object' && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message || fallback;
  }
  return fallback;
}

/** 从任意 catch 值里取出错误名（`AbortError` 判定用）；取不到时返回空串。 */
export function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  if (err !== null && typeof err === 'object' && 'name' in err) {
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}
