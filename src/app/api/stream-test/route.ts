import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import { fetchWithSafeRedirects } from '@/lib/fetch-utils';
import { rewriteM3u8 } from '@/lib/m3u8';

/**
 * 临时 Worker 原生流式转发测试入口：
 * /api/stream-test?url=<encodeURIComponent(target)>
 *
 * 与 /api/proxy 分离，便于对比直连和 Worker 转发。
 * 通过 fetchWithSafeRedirects 使用运行时原生 fetch，逐跳执行 SSRF 校验；
 * HLS manifest 重写到本路由，TS/key/map 等媒体资源直接透传 ReadableStream。
 *
 * 测试结束后可删除本文件及对应部署。
 */
export const runtime = 'nodejs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const targetUrl = new URL(req.url).searchParams.get('url');
  if (!targetUrl) return jsonError('缺少 url 参数', 400);

  const verdict = await checkUpstreamAllowed(targetUrl);
  if (!verdict.ok) return jsonError(verdict.reason, 403);

  const headers = new Headers({
    'User-Agent': UA,
    Accept: '*/*',
  });
  const range = req.headers.get('range');
  if (range) headers.set('Range', range);

  try {
    const { res: upstream, finalUrl } = await fetchWithSafeRedirects(
      targetUrl,
      {
        method: 'GET',
        headers,
        signal: req.signal,
      }
    );

    // 错误响应不能当作 HLS manifest 重写；保留上游状态码、正文和诊断头，
    // 便于区分上游返回的 HTTP 错误与 Worker fetch 抛出的异常。
    if (!upstream.ok) {
      const errorHeaders = new Headers({
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      });
      for (const name of [
        'content-type',
        'content-length',
        'content-range',
        'date',
        'server',
        'cf-ray',
        'cf-error-type',
        'cf-error-origin',
        'location',
      ]) {
        const value = upstream.headers.get(name);
        if (value) errorHeaders.set(name, value);
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: errorHeaders,
      });
    }

    const contentType = upstream.headers.get('content-type') || '';
    const pathname = new URL(finalUrl).pathname.toLowerCase();
    const isM3u8 =
      contentType.includes('mpegurl') ||
      contentType.includes('x-mpegurl') ||
      pathname.endsWith('.m3u8');

    if (isM3u8) {
      const manifest = await upstream.text();
      return new NextResponse(
        rewriteM3u8(manifest, finalUrl, 0, '/api/stream-test?url='),
        {
          status: upstream.status,
          headers: {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-store',
            'X-Accel-Buffering': 'no',
          },
        }
      );
    }

    // 不读取、不拼接媒体 body：直接把上游 ReadableStream 交给响应层。
    const outHeaders = new Headers({
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
    });
    for (const name of [
      'content-type',
      'accept-ranges',
      'content-range',
      'etag',
      'last-modified',
    ]) {
      const value = upstream.headers.get(name);
      if (value) outHeaders.set(name, value);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: outHeaders,
    });
  } catch (error) {
    return jsonError(
      `Worker 流式转发失败: ${error instanceof Error ? error.message : '未知错误'}`,
      502
    );
  }
}
